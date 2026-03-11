const base = import.meta.env.BASE_URL; // always has trailing slash

export function url(path: string): string {
  return `${base}${path.replace(/^\//, "")}`;
}
