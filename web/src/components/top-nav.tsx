"use client";

import { Compass, CreditCard, FileStack, History, ImageIcon, LogOut, Menu, Moon, Shield, Sparkles, Sun, User, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { DEFAULT_SITE_TITLE } from "@/components/app-title";
import { SideDrawer } from "@/components/ui/side-drawer";
import { getStoredThemeMode, setThemeMode, THEME_MODES, type ThemeMode } from "@/components/theme-controller";
import { cn } from "@/lib/utils";
import { clearStoredAuthKey } from "@/store/auth";

const adminNavItems = [
  { href: "/admin", label: "总览" },
  { href: "/admin/accounts", label: "号池管理" },
  { href: "/admin/users", label: "用户管理" },
  { href: "/admin/register", label: "注册机" },
  { href: "/admin/settings", label: "后台设置" },
  { href: "/admin/keys", label: "兑换码管理" },
  { href: "/admin/usage", label: "用量记录" },
  { href: "/admin/cache", label: "缓存查看" },
  { href: "/admin/audit", label: "操作审计" },
];

const userNavItems = [
  { href: "/image", label: "画图工作台" },
  { href: "/editable-files", label: "PPT/PSD" },
  { href: "/api-keys", label: "个人中心" },
  { href: "/recharge", label: "自助充值" },
];

function isHiddenPath(pathname: string) {
  return pathname === "/" || pathname === "/login" || pathname === "/admin/login";
}

export function TopNav() {
  const pathname = usePathname().replace(/\/+$/, "") || "/";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [siteTitle, setSiteTitle] = useState(DEFAULT_SITE_TITLE);
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");
  const isAdminArea = pathname.startsWith("/admin");
  const navItems = isAdminArea ? adminNavItems : userNavItems;

  const handleLogout = async () => {
    await clearStoredAuthKey(isAdminArea ? "admin" : "user");
    router.replace(isAdminArea ? "/admin/login" : "/login");
  };

  const openImageHistory = () => {
    setMenuOpen(false);
    window.sessionStorage.setItem("image:open-history", "1");
    if (pathname === "/image") {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("image:open-history"));
      });
      return;
    }
    router.push("/image");
  };

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const current = document.documentElement.dataset.siteTitle;
    if (current) setSiteTitle(current);

    const handleSiteTitle = (event: Event) => {
      const customEvent = event as CustomEvent<{ siteTitle?: string }>;
      setSiteTitle(customEvent.detail?.siteTitle || DEFAULT_SITE_TITLE);
    };

    window.addEventListener("app:site-title", handleSiteTitle);
    return () => window.removeEventListener("app:site-title", handleSiteTitle);
  }, []);

  useEffect(() => {
    setThemeModeState(getStoredThemeMode());

    const handleThemeMode = (event: Event) => {
      const customEvent = event as CustomEvent<{ mode?: ThemeMode }>;
      if (customEvent.detail?.mode) setThemeModeState(customEvent.detail.mode);
    };

    window.addEventListener("app:theme-mode", handleThemeMode);
    return () => window.removeEventListener("app:theme-mode", handleThemeMode);
  }, []);

  if (isHiddenPath(pathname)) {
    return null;
  }

  return (
    <>
      <header className="glass-panel section-shell relative rounded-[20px] border border-white/55 px-3 py-2 sm:rounded-[28px] sm:px-5 sm:py-3 lg:px-6 lg:py-4">
        <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-56 bg-[radial-gradient(circle_at_center,_rgba(222,176,100,0.18),_transparent_68%)] sm:block" />
        <div className="relative flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            {!isAdminArea ? (
              <button
                type="button"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/65 bg-white/65 text-stone-700 shadow-sm transition hover:border-stone-300 hover:bg-white hover:text-stone-950 sm:size-11 sm:rounded-2xl"
                onClick={() => setMenuOpen(true)}
                aria-label="打开菜单"
                aria-expanded={menuOpen}
              >
                <Menu className="size-4 sm:size-5" />
              </button>
            ) : null}

          <Link href={isAdminArea ? "/admin/accounts" : "/image"} className="flex min-w-0 items-center gap-2 text-stone-950 sm:gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-stone-950 text-white shadow-[0_18px_30px_-18px_rgba(0,0,0,0.65)] sm:size-11 sm:rounded-2xl">
              {isAdminArea ? <Shield className="size-4 sm:size-5" /> : <Sparkles className="size-4 sm:size-5" />}
            </div>
            <div className="min-w-0">
              <div className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-stone-500 sm:block">
                {isAdminArea ? "Admin Console" : "Creative Engine"}
              </div>
              <div
                className="truncate text-sm font-semibold tracking-tight sm:text-xl"
                style={{ fontFamily: '"Iowan Old Style","Palatino Linotype","Book Antiqua",serif' }}
              >
                {isAdminArea ? `${siteTitle}后台` : `${siteTitle}工作台`}
              </div>
            </div>
          </Link>
          <div className="hidden max-w-xl text-[13px] leading-5 text-stone-600 sm:block">
            {isAdminArea ? "集中处理账号、兑换码与缓存配置。" : "更快整理提示词、参考图与生成结果。"}
          </div>
        </div>

        <div className={cn("relative items-center justify-between gap-2 xl:flex-col xl:items-end", isAdminArea ? "flex" : "hidden")}>
          <nav className="hide-scrollbar flex min-w-0 flex-1 gap-1.5 overflow-x-auto sm:flex-wrap sm:gap-2">
            {navItems.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition sm:px-4 sm:text-sm",
                    active
                      ? "border-stone-950 bg-stone-950 text-white shadow-[0_16px_30px_-18px_rgba(28,25,23,0.85)]"
                      : "border-white/65 bg-white/55 text-stone-700 hover:border-stone-300 hover:bg-white/80 hover:text-stone-950",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-1.5 text-xs text-stone-600 sm:flex-wrap sm:gap-2 sm:text-sm">
            {isAdminArea ? (
              <Link
                href="/image"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/60 bg-white/55 px-2.5 py-1.5 transition hover:bg-white/80 hover:text-stone-950 sm:gap-2 sm:px-3.5"
              >
                <Compass className="size-4" />
                画图前台
              </Link>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/60 bg-white/55 px-2.5 py-1.5 transition hover:bg-white/80 hover:text-stone-950 sm:gap-2 sm:px-3.5"
              onClick={() => void handleLogout()}
            >
              <LogOut className="size-4" />
              退出
            </button>
          </div>
        </div>
      </div>

      </header>

      {!isAdminArea ? (
        <SideDrawer open={menuOpen} onOpenChange={setMenuOpen} title="工作台菜单">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">Menu</div>
                <div className="mt-1 truncate text-base font-semibold text-stone-950">{siteTitle}工作台</div>
              </div>
              <button
                type="button"
                className="inline-flex size-10 items-center justify-center rounded-2xl border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 hover:text-stone-950"
                onClick={() => setMenuOpen(false)}
                aria-label="关闭菜单"
              >
                <X className="size-4" />
              </button>
            </div>

            <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3" onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) setMenuOpen(false);
            }}>
              <div className="xl:hidden">
                <MenuAction icon={<History className="size-4" />} label="历史记录" active={pathname === "/image"} onClick={openImageHistory} />
              </div>
              <MenuLink icon={<ImageIcon className="size-4" />} href="/image" label="画图工作台" active={pathname === "/image"} />
              <MenuLink icon={<FileStack className="size-4" />} href="/editable-files" label="PPT/PSD" active={pathname === "/editable-files"} />
              <MenuLink icon={<User className="size-4" />} href="/api-keys" label="个人中心" active={pathname === "/api-keys"} />
              <MenuLink icon={<CreditCard className="size-4" />} href="/recharge" label="自助充值" active={pathname === "/recharge"} />
            </nav>

            <div className="flex flex-col gap-2 border-t border-stone-200 p-3">
              <div className="rounded-2xl border border-stone-200 bg-white p-1">
                <div className="mb-1 flex items-center gap-2 px-2 py-1 text-xs font-medium text-stone-500">
                  {themeMode === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
                  配色
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {THEME_MODES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={cn(
                        "h-9 rounded-xl px-2 text-xs font-medium transition",
                        themeMode === item.value ? "bg-stone-950 text-white" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950",
                      )}
                      onClick={() => {
                        setThemeMode(item.value);
                        setThemeModeState(item.value);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="flex h-12 w-full items-center gap-3 rounded-2xl border border-stone-200 bg-white px-4 text-sm font-medium text-stone-700 transition hover:bg-stone-50 hover:text-stone-950"
                onClick={() => void handleLogout()}
              >
                <LogOut className="size-4" />
                退出
              </button>
            </div>
          </div>
        </SideDrawer>
      ) : null}
    </>
  );
}

function MenuLink({ icon, href, label, active }: { icon: ReactNode; href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-12 items-center gap-3 rounded-2xl border px-4 text-sm font-medium transition",
        active
          ? "border-stone-950 bg-stone-950 text-white"
          : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50 hover:text-stone-950",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}

function MenuAction({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-12 items-center gap-3 rounded-2xl border px-4 text-left text-sm font-medium transition",
        active
          ? "border-stone-950 bg-stone-950 text-white"
          : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50 hover:text-stone-950",
      )}
    >
      {icon}
      {label}
    </button>
  );
}
