"use client";

import { ExternalLink, Gift, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchUserKeyInfo, redeemUserCode } from "@/lib/api";

export default function RechargePage() {
  const [redeemCode, setRedeemCode] = useState("");
  const [availableQuota, setAvailableQuota] = useState("加载中");
  const [isRedeeming, setIsRedeeming] = useState(false);

  useEffect(() => {
    fetchUserKeyInfo()
      .then((data) => setAvailableQuota(data.remaining === -1 ? "无限" : String(data.remaining)))
      .catch(() => setAvailableQuota("暂不可用"));
  }, []);

  const handleRedeem = async () => {
    if (isRedeeming) return;
    const code = redeemCode.trim();
    if (!code) {
      toast.error("请输入兑换码");
      return;
    }
    setIsRedeeming(true);
    try {
      const data = await redeemUserCode(code);
      setRedeemCode("");
      setAvailableQuota(data.user.remaining === -1 ? "无限" : String(data.user.remaining));
      toast.success("兑换成功，积分已到账");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "兑换失败");
    } finally {
      setIsRedeeming(false);
    }
  };

  return (
    <section className="flex min-h-[calc(100dvh-6rem)] flex-col gap-4">
      <Card className="rounded-xl border-stone-200 bg-white shadow-sm">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
              <Gift className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-stone-950 sm:text-lg">积分兑换</h1>
              <p className="mt-0.5 text-sm text-stone-500">当前积分 {availableQuota}</p>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:max-w-md">
            <Input
              value={redeemCode}
              onChange={(event) => setRedeemCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRedeem();
              }}
              placeholder="输入兑换码"
              className="h-10 rounded-lg border-stone-200"
            />
            <Button className="h-10 rounded-lg" onClick={() => void handleRedeem()} disabled={isRedeeming}>
              {isRedeeming ? <LoaderCircle className="size-4 animate-spin" /> : null}
              兑换
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="flex min-h-[70dvh] flex-1 flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-3 sm:px-5">
          <div>
            <div className="text-[10px] font-semibold uppercase text-stone-500">Recharge</div>
            <h2 className="mt-0.5 text-sm font-semibold text-stone-950 sm:text-base">自助充值</h2>
          </div>
          <a
            href="https://wzyp.cn/shop/ai8888/581f3y"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 px-3 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            <ExternalLink className="size-4" />
            新窗口打开
          </a>
        </header>
        <iframe
          src="https://wzyp.cn/shop/ai8888/581f3y"
          title="自助充值"
          className="min-h-[68dvh] flex-1 border-0 bg-white"
          referrerPolicy="no-referrer"
          allow="payment *"
        />
      </section>
    </section>
  );
}
