"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { fetchUserKeyInfo } from "@/lib/api";

export function UserAccess({ children }: { children: ReactNode }) {
  const [state, setState] = useState("loading");
  useEffect(() => { let active = true; fetchUserKeyInfo().then(() => { if (active) setState("ready"); }).catch(() => { if (active) setState("denied"); }); return () => { active = false; }; }, []);
  if (state === "loading") return <p className="p-6">正在验证登录…</p>;
  if (state !== "ready") return <p className="p-6">请先<Link href="/login" className="underline">登录个人账户</Link>后访问。</p>;
  return <>{children}</>;
}
