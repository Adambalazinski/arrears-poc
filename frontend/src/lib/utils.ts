// shadcn/ui's `cn` helper. We'll add `clsx` + `tailwind-merge` when the first
// shadcn component lands; for now a thin stub keeps the alias resolvable.
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
