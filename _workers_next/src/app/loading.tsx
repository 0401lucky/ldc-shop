export default function Loading() {
  return (
    <div className="container relative py-8 md:py-16 space-y-6">
      <div className="pointer-events-none absolute inset-0 -z-10 lucky-ambient" />
      <div className="h-8 w-40 rounded-full bg-primary/10 animate-pulse" />
      <div className="h-12 w-full rounded-2xl bg-primary/8 animate-pulse" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-44 rounded-[1.5rem] border border-primary/8 bg-card/70 animate-pulse"
            style={{ animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
