import type { Metadata, Site, Socials } from "@types";

export const SITE: Site = {
  TITLE: "Danny Gale",
  DESCRIPTION: "Principal HDE at Amazon. Building things with AI, RISC-V, and whatever else seems interesting.",
  EMAIL: "danny@galelabs.dev",
  NUM_POSTS_ON_HOMEPAGE: 5,
  NUM_PROJECTS_ON_HOMEPAGE: 3,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION: "Danny Gale — Principal HDE at Amazon.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "Writing on hardware, AI, and engineering.",
};

export const PROJECTS: Metadata = {
  TITLE: "Projects",
  DESCRIPTION: "Things I'm building.",
};

export const SOCIALS: Socials = [
  {
    NAME: "GitHub",
    HREF: "https://github.com/dannygale",
  },
  {
    NAME: "LinkedIn",
    HREF: "https://linkedin.com/in/dannygale",
  },
];
