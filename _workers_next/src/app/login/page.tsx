"use client"

import { signIn } from "next-auth/react"
import { useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Github, LogIn } from "lucide-react"
import { Logo } from "@/components/icons/logo"

export default function LoginPage() {
  const searchParams = useSearchParams()
  const callbackUrl = searchParams.get("callbackUrl") || "/"

  return (
    <main className="container relative flex min-h-[70vh] items-center justify-center py-16">
      <div className="pointer-events-none absolute inset-0 -z-10 lucky-ambient" />

      <Card className="tech-card relative w-full max-w-md overflow-hidden border-primary/15 shadow-[0_28px_70px_-40px_rgba(22,101,52,0.35)]">
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-400 via-primary to-lime-400" />
        <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-primary/10 blur-2xl" />
        <div className="absolute -bottom-12 -left-8 h-28 w-28 rounded-full bg-lime-400/10 blur-2xl" />

        <CardHeader className="relative space-y-3 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <Logo className="h-8 w-8" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">欢迎回来</CardTitle>
          <CardDescription className="text-sm leading-6">
            登录 Lucky，继续你的幸运旅程
          </CardDescription>
        </CardHeader>
        <CardContent className="relative space-y-3 pb-8">
          <Button
            size="lg"
            variant="outline"
            className="w-full rounded-xl border-border/50 hover:border-primary/30 hover:bg-primary/5"
            onClick={() => signIn("github", { callbackUrl })}
          >
            <Github className="mr-2 h-4 w-4" />
            使用 GitHub 登录
          </Button>
          <Button
            size="lg"
            className="w-full rounded-xl"
            onClick={() => signIn("linuxdo", { callbackUrl })}
          >
            <LogIn className="mr-2 h-4 w-4" />
            使用 Linux DO 登录
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
