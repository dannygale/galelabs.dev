---
title: "Introducing VeriPy: Hardware Description in Python"
description: "Write Python, get simulation and synthesizable Verilog from the same source — automatically validated against each other."
date: "2026-03-08"
tags: ["hardware", "python", "riscv", "hdl"]
---

I've been building a RISC-V core, and like most hardware projects it involves a lot of Verilog. Verilog is fine — it's the lingua franca of RTL — but the tooling around it is painful. Simulation requires a separate testbench language, the type system is a minefield of implicit truncations, and the blocking/non-blocking assignment distinction is a source of bugs that has probably cost the industry millions of engineering hours but is structurally preventable.

I got tired of the Verilog tooling tax. So I built a Python HDL that simulates natively and emits synthesizable Verilog from the same source. Write your module once in Python, run it as a simulation, generate Verilog, and verify both paths produce identical results cycle-by-cycle. It includes a `veripy` CLI to bootstrap a project, build, and run tests.

I got tired of keeping an ISS, a cycle-accurate simulator, and RTL in sync, so I wrote [VeriPy](https://github.com/dannygale/veripy). It automatically tests the models for a given module against each other to ensure consistency. Everything compiles down to native C and simulates fast.

Before you ask: why not Amaranth or PyMTL3? I thought they were both too clunky. I wanted clean, pythonic syntax. Here's what I came up with:

## What it looks like

Here's a counter 

```python
from veripy import module, Input, OutputReg, posedge
from veripy.context import always

@module
def counter(width=8):
    clock  = Input()
    reset  = Input()
    enable = Input()
    count  = OutputReg(width)

    @always(posedge(clock))
    def increment():
        if reset:
            count = 0
        elif enable:
            count += 1
```

Function arguments become Verilog parameters. Signals are local variables — no `self.` needed. Call `counter(width=4).to_verilog()` and you get synthesizable Verilog. Run it through `SimEngine` and you get a Python simulation. Both paths are tested against each other automatically.

This is the ergonomic `@module` API. There's also a class-based one:

```python
from veripy import Module, Input, OutputReg, posedge

class Counter(Module):
    def __init__(self, width=8):
        self.clock  = Input()
        self.reset  = Input()
        self.enable = Input()
        self.count  = OutputReg(width)
        super().__init__()

    def rtl(self):
        @self.always(posedge(self.clock))
        def increment():
            if self.reset:
                self.count = 0
            elif self.enable:
                self.count += 1
```

Both produce identical simulation results and Verilog output. The class-based API gives you full Python class machinery — inheritance, mixins, dynamic port construction — at the cost of `self.` everywhere.

Here's the same counter in Amaranth and PyMTL3 for comparison:

```python
# Amaranth
from amaranth import *

class Counter(Elaboratable):
    def __init__(self, width=8):
        self.reset  = Signal()
        self.enable = Signal()
        self.count  = Signal(width)

    def elaborate(self, platform):
        m = Module()
        with m.If(self.reset):
            m.d.sync += self.count.eq(0)
        with m.Elif(self.enable):
            m.d.sync += self.count.eq(self.count + 1)
        return m
```

```python
# PyMTL3
from pymtl3 import *

class Counter(Component):
    def construct(s, width=8):
        s.reset  = InPort()
        s.enable = InPort()
        s.count  = OutPort(mk_bits(width))

        @update_ff
        def up_count():
            if s.reset:
                s.count <<= 0
            elif s.enable:
                s.count <<= s.count + 1
```

Amaranth requires an `elaborate()` method that builds a module object — you're constructing a description tree, not writing logic directly. PyMTL3 uses `s.` everywhere and `<<=` for non-blocking assignment. Both are workable, but neither reads like Python. VeriPy uses plain `=` and plain `if` — the AST rewriter handles the rest (more on that below).

## Three tiers of fidelity

For more complex modules, VeriPy supports three simulation tiers in the same module definition: functional, cycle-accurate, and RTL. A pipelined multiplier illustrates why this matters:

```python
from veripy import module, Input, OutputReg, Register, posedge
from veripy.context import functional, cycle, always
from collections import deque

@module
def pipelined_mul(width=8):
    clock     = Input()
    a         = Input(width)
    b         = Input(width)
    result    = OutputReg(width * 2)
    valid     = OutputReg()
    mul_reg   = Register(width * 2)
    valid_reg = Register()

    # Tier 1: functional — what it computes, no timing
    @functional
    def model():
        result = a * b
        valid  = 1

    # Tier 2: cycle-accurate — when the result appears (2-cycle latency)
    @cycle(posedge(clock), init=dict(pipe=deque([0, 0], maxlen=2)))
    def cycle_model(pipe):
        pipe.appendleft(int(a * b))
        result = pipe[-1]
        valid  = 1

    # Tier 3: RTL — how the hardware is actually structured
    @always(posedge(clock))
    def rtl_seq():
        mul_reg   = a * b      # stage 1: compute
        valid_reg = 1
        result    = mul_reg    # stage 2: register output
        valid     = valid_reg
```

The functional model says "multiply a and b, result is immediate." The cycle model says "result appears 2 cycles after inputs." The RTL says "here are the actual pipeline registers." Three different levels of abstraction, all in one place.

The test framework auto-detects which models are present and runs each independently. The functional model runs first as a fast sanity check. The cycle model validates timing. The RTL model runs the full behavioral simulation and any compiled backends (Verilator, FPGA). A testbench written against the functional model runs unchanged against the RTL — if they disagree, you have a bug.



This is the most important design decision in VeriPy, and I want to be upfront about it: **`=` inside `@comb` blocks is always a blocking assignment. `=` inside `@always` blocks is always non-blocking.**. I recognize this is opinionated, but it's clean. There is some magic happening behind the scenes here that I'll talk about below

```python
@comb
def logic():
    out = a + b      # blocking — combinational wire, emits: assign out = a + b

@always(posedge(clock))
def seq():
    reg = d          # non-blocking — register, emits: reg <= d
```

You write `=` in both cases. VeriPy knows which kind of assignment to emit based on which block you're in. This has a useful implication for signal types too: a signal assigned in a `@comb` block is inferred as a `wire`; a signal assigned in an `@always` block is inferred as a `reg`. The type follows the context, not a declaration. 

If you have a design that genuinely needs blocking assignments in a sequential block, I'd love to hear about it. But for the 99% case, the rule is clean and the bugs it prevents are real. 

## The magic: assignment rewriting

Here's where things get interesting. Python doesn't have a way to intercept `x = value` — assignment is a statement, not an operator. So how does `cnt = cnt + 1` inside an `@always` block actually update the hardware register instead of just rebinding the local variable? VeriPy uses AST rewriting.

When you decorate a function with `@comb` or `@always`, VeriPy inspects the function's source code, parses it into an AST, and rewrites every assignment to a known signal name:

```python
count = cnt + 1        # what you write
count._assign(count + 1) # what actually runs
```

The rewriter knows which names are signals (because they were declared in the module body as `Input`, `Output`, `Register`, etc.) and leaves everything else alone. Regular Python variables work normally:

```python
@comb
def compute():
    temp = int(a) + int(b)   # local variable — untouched
    result = temp * 2         # signal — rewritten to result._assign(temp * 2)
```

The same rewriting handles sub-module port drives, bit-slice writes, and augmented assignment:

```python
alu.a = x            # → alu.a._assign(x)
data[3:0] = 0xF      # → data[3:0]._assign(0xF)
cnt += 1             # → cnt._assign(cnt + 1)
```

The rewritten function is compiled and cached. The original source is used for Verilog emission — the rewriter only affects the Python simulation path.

This is the core trick that makes VeriPy feel like Python rather than a Python wrapper around Verilog. You write Python but you get hardware logic

## Signals are lazy expressions

One more piece of magic worth understanding: signal operators don't evaluate immediately. `a + b` returns an `_Expr` object that re-evaluates every time you call `int()` on it:

```python
a = Signal(8); a.set(10)
b = Signal(8); b.set(3)

expr = a + b   # _Expr — not evaluated yet
int(expr)      # 13
a.set(20)
int(expr)      # 23 — re-evaluates with current values
```

This is what makes `@comb` blocks work correctly in simulation: the expression `a + b` in a combinational block isn't a snapshot, it's a live computation. Change `a`, and anything that depends on `a + b` sees the new value on the next evaluation.

It also means you can pass expressions around as first-class values — pipeline stage sources, interface connections, formal properties — without needing intermediate registers.

## Testing

VeriPy's test system lets you plug any model into any testbench. Because the functional, cycle-accurate, and RTL models all share the same port interface, they can all be driven from the same stimulus. Testbenches can target a specific tier or run across all of them to validate consistency.

```python
from veripy.verify import TestBench, initial

class TestMul(TestBench):
    def create_module(self):
        return pipelined_mul(width=8)

    def test_multiply(self):
        dut = self.dut
        self.clock('clock', period=10)

        @initial
        def stimulus():
            dut.a = 3
            dut.b = 4
            yield 20   # 2 posedges — result appears after pipeline latency
            assert dut.result == 12
```

`self.dut` is a signal namespace: `dut.a = 3` sets an input, `dut.result` reads an output. `@initial` registers the generator as a testbench stimulus block. This runs three times automatically — once per model. If any model disagrees, the test fails.

Run tests with the CLI:

```
veripy test                        # all models, all backends
veripy test --model functional     # fast sanity pass only
veripy test --model rtl -j         # RTL only, parallel
```

## The CLI

Bootstrap a project:

```
veripy init my_project
cd my_project
veripy build counter.py            # emit Verilog to stdout
veripy build counter.py -o rtl/    # write .v files to rtl/
veripy test                        # discover and run all TestBench subclasses
veripy test --model cycle          # run cycle model only
veripy lint counter.py             # static checks
veripy formal counter.py           # generate SymbiYosys .sby
```

`veripy test` discovers all `TestBench` subclasses in the project, runs each test method against every available model, and cross-checks outputs. `--model` pins to a specific model — useful during development when you want fast iteration on the functional model before committing to RTL.

## Simulation performance

VeriPy has three compiled backends: CSim (native C), CySim-C (model cached as `.so`, testbench compiled against it — single compilation unit), and Verilator. All three compile with `-O3 -march=native`.

The benchmark is a SpiHub: four SPI controllers plus a round-robin arbiter, flattened to a single module. This is a realistic design with multiple FSMs, FIFOs, and combinational arbitration logic.

| Transfers | CySim-C compile | CySim-C exec | CySim-C total | CSim compile | CSim exec | CSim total | Verilator compile | Verilator exec | Verilator total |
|-----------|----------------|--------------|---------------|--------------|-----------|------------|-------------------|----------------|-----------------|
| 100 | 1.69s | 0.0003s | 1.69s | 1.87s | 0.0002s | 1.87s | 4.50s | 0.001s | 4.50s |
| 1,000 | 0.001s* | 0.002s | 0.003s | 1.71s | 0.002s | 1.71s | 4.12s | 0.003s | 4.12s |
| 10,000 | 0.001s* | 0.016s | 0.017s | 1.69s | 0.016s | 1.71s | 4.24s | 0.013s | 4.25s |
| 100,000 | 0.001s* | 0.135s | 0.136s | 1.74s | 0.129s | 1.86s | 4.16s | 0.142s | 4.30s |
| 1,000,000 | 0.001s* | 1.174s | 1.175s | 1.72s | 1.285s | 3.01s | 3.71s | 1.339s | 5.05s |

*cached — model `.so` reused from previous run

**CySim-C is faster than Verilator at execution** (1.14× at 1M transfers) while compiling 2× faster. The key optimizations: NBA temporaries kept in registers rather than struct fields, sequential logic split into per-always-block functions so the compiler optimizes each independently, and the model inlined into the testbench as a single compilation unit.

CSim has comparable execution speed but pays the ~1.7s compile on every run. CySim-C caches the model `.so` by content hash — subsequent runs pay only ~0.1s for the thin testbench shim. The practical choice: CySim-C during development (fast iteration, Verilator-class execution), CSim for one-off validation runs where you want the simplest setup.

## What's next

VeriPy is what I'm using to build the RISC-V core. It has a lot more in it — pipelines with per-stage stall/flush, CSR register maps that generate RTL and C headers from a single definition, formal property checking, AXI4-Lite interfaces, CDC primitives — but the counter example above captures the core idea.

The code is on [GitHub](https://github.com/dannygale/veripy). It's early but functional. If you're doing hardware work in Python, I'd be curious what you think.
