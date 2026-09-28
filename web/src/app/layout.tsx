import type { Metadata } from "next";
import { Toaster } from "sonner";

import { AppTitle } from "@/components/app-title";
import { ThemeController } from "@/components/theme-controller";
import { TopNav } from "@/components/top-nav";
import { DesignProvider } from "@/components/design-provider";

import "./globals.css";
import "./studio.css";

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
          offset={96}
          mobileOffset={128}
          closeButton
          duration={3000}
          richColors
          toastOptions={{
            classNames: {
              toast: "!rounded-xl !border !border-border !bg-popover !text-popover-foreground !shadow-lg",
              title: "!text-sm !font-semibold",
              description: "!text-sm !text-stone-600",
            },
          }}
        />
        <AppTitle />
        <ThemeController />
        <DesignProvider>
        <main className="studio-shell">
          <div className="studio-shell-inner">
            <TopNav />
            <div className="min-h-0 flex-1">{children}</div>
          </div>
        </main>
        </DesignProvider>
      </body>
    </html>
  );
}
