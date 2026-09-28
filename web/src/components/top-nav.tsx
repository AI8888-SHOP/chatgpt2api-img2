"use client";

import { Aperture, Compass, CreditCard, FileStack, History, ImageIcon, LogOut, Menu, Shield, User, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { DEFAULT_SITE_TITLE } from "@/components/app-title";
import { SideDrawer } from "@/components/ui/side-drawer";
import { getStoredThemeMode, setThemeMode, THEME_MODES, type ThemeMode } from "@/components/theme-controller";
import { DesignSwitcher } from "@/components/design-switcher";
import { clearStoredAuthKey } from "@/store/auth";

const adminNavItems = [
  { href: "/admin", label: "总览" }, { href: "/admin/accounts", label: "号池管理" },
  { href: "/admin/users", label: "用户管理" }, { href: "/admin/register", label: "注册机" },
  { href: "/admin/settings", label: "后台设置" }, { href: "/admin/keys", label: "兑换码管理" },
  { href: "/admin/usage", label: "用量记录" }, { href: "/admin/ui-trial", label: "界面试用" },
  { href: "/admin/cache", label: "缓存查看" }, { href: "/admin/audit", label: "操作审计" },
];
const userNavItems = [
  { href: "/image", label: "画图工作台", icon: ImageIcon },
  { href: "/editable-files", label: "PPT / PSD", icon: FileStack },
  { href: "/api-keys", label: "个人中心", icon: User },
  { href: "/recharge", label: "自助充值", icon: CreditCard },
];

export function TopNav() {
  const pathname = usePathname().replace(/\/+$/, "") || "/";
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [siteTitle, setSiteTitle] = useState(DEFAULT_SITE_TITLE);
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");
  const admin = pathname.startsWith("/admin");
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    setSiteTitle(document.documentElement.dataset.siteTitle || DEFAULT_SITE_TITLE);
    setThemeModeState(getStoredThemeMode());
    const title = (event: Event) => setSiteTitle((event as CustomEvent).detail?.siteTitle || DEFAULT_SITE_TITLE);
    const theme = (event: Event) => setThemeModeState((event as CustomEvent).detail.mode);
    window.addEventListener("app:site-title", title); window.addEventListener("app:theme-mode", theme);
    return () => { window.removeEventListener("app:site-title", title); window.removeEventListener("app:theme-mode", theme); };
  }, []);
  const logout = async () => { await clearStoredAuthKey(admin ? "admin" : "user"); router.replace(admin ? "/admin/login" : "/login"); };
  const history = () => {
    setMenuOpen(false);
    if (pathname === "/image") requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("image:open-history")));
    else { window.sessionStorage.setItem("image:open-history", "1"); router.push("/image"); }
  };
  if (["/", "/login", "/admin/login"].includes(pathname)) return null;
  return <>
    <header className="studio-topnav">
      <div className="studio-topbar">
        <div className="studio-brand-group">
          {!admin && <button type="button" className="studio-icon-button studio-menu-trigger" aria-label="打开菜单" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={19} /></button>}
          <Link className="studio-brand" href={admin ? "/admin" : "/image"}><span className="studio-logo">{admin ? <Shield size={19} /> : <Aperture size={19} />}</span><span className="truncate">{siteTitle}{admin ? " · 后台" : ""}</span></Link>
        </div>
        {!admin && <nav className="studio-desktop-nav" aria-label="主导航">{userNavItems.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}</nav>}
        <div className="studio-header-actions">
          {!admin && <button type="button" className="studio-icon-button" aria-label="打开历史记录" onClick={history}><History size={18} /></button>}
          <DesignSwitcher user={!admin} />
          <select className="studio-theme-select" aria-label="明暗模式" value={themeMode} onChange={event => setThemeMode(event.target.value as ThemeMode)}>{THEME_MODES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
          {admin && <><Link href="/image" className="studio-icon-button" aria-label="画图前台"><Compass size={18} /></Link><button type="button" className="studio-icon-button" aria-label="退出后台" onClick={() => void logout()}><LogOut size={18} /></button></>}
        </div>
      </div>
      {admin && <nav className="studio-admin-nav" aria-label="后台导航">{adminNavItems.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}</nav>}
    </header>
    {!admin && <SideDrawer open={menuOpen} onOpenChange={setMenuOpen} title="工作台菜单">
      <div className="studio-menu">
        <div className="studio-menu-heading"><strong>{siteTitle}</strong><button type="button" className="studio-icon-button" aria-label="关闭菜单" onClick={() => setMenuOpen(false)}><X size={19} /></button></div>
        <nav className="studio-menu-links" aria-label="工作台导航">
          <button type="button" onClick={history}><History size={18} />历史记录</button>
          {userNavItems.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined} onClick={() => setMenuOpen(false)}><item.icon size={18} />{item.label}</Link>)}
        </nav>
        <div className="studio-menu-footer"><span className="text-sm text-muted-foreground">界面风格可在顶部随时切换</span><button type="button" className="studio-text-button" onClick={() => void logout()}><LogOut size={17} />退出登录</button></div>
      </div>
    </SideDrawer>}
  </>;
}
