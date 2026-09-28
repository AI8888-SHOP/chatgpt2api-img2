export default function RechargePage() {
  return (
    <section className="flex min-h-[calc(100dvh-6rem)] flex-col overflow-hidden rounded-[22px] border border-stone-200 bg-[#fbfbfa] shadow-[0_14px_40px_-30px_rgba(15,23,42,0.18)] sm:rounded-[30px]">
      <div className="border-b border-stone-200 px-3 py-2.5 sm:px-5 sm:py-4">
        <div className="hidden text-[10px] font-semibold uppercase tracking-[0.22em] text-stone-500 sm:block">Recharge</div>
        <h1 className="text-base font-semibold tracking-tight text-stone-950 sm:mt-1 sm:text-xl">自助充值</h1>
        <p className="mt-2 text-sm leading-6 text-stone-500">购买相应画图积分后，复制兑换码到“个人中心”兑换</p>
      </div>

      <iframe
        src="https://pay.ldxp.cn/shop/ai8888"
        title="自助充值"
        className="min-h-0 flex-1 border-0 bg-white"
        referrerPolicy="no-referrer-when-downgrade"
        allow="payment *"
      />
    </section>
  );
}
