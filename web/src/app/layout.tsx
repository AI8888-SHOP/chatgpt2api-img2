import type { Metadata } from "next";
import { Toaster } from "sonner";

import { AppTitle } from "@/components/app-title";
import { ThemeController } from "@/components/theme-controller";
import { TopNav } from "@/components/top-nav";

import "./globals.css";

export const metadata: Metadata = {
  title: "image 专业绘图",
  description: "image 专业绘图后台与画图工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">
        <Toaster
          position="top-center"
          richColors
          toastOptions={{
            classNames: {
              toast: "!rounded-2xl !border !border-white/60 !bg-[#fffaf4]/95 !text-stone-900 !shadow-[0_20px_60px_-28px_rgba(77,48,22,0.35)]",
              title: "!text-sm !font-semibold",
              description: "!text-sm !text-stone-600",
            },
          }}
        />
        <AppTitle />
        <ThemeController />
        <main className="relative min-h-screen overflow-hidden px-2 py-2 text-stone-900 sm:px-4 sm:py-4 lg:px-5 lg:py-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.72),_transparent_72%)]" />
          <div className="relative mx-auto flex min-h-[calc(100vh-1rem)] w-full max-w-[1560px] flex-col gap-3 lg:min-h-[calc(100vh-2.5rem)]">
            <TopNav />
            <div className="min-h-0 flex-1">{children}</div>
          </div>
        </main>
      </body>
    </html>
  );
}
