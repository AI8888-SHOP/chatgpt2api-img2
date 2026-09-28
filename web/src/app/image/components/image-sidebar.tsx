"use client";

import { History, LoaderCircle, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { getStoredImageSrc, type ImageConversation } from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[];
  isLoadingHistory: boolean;
  generatingIds: Set<string>;
  selectedConversationId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

function buildConversationPreviewSrc(conversation: ImageConversation) {
  const generated = conversation.images.find((image) => getStoredImageSrc(image));
  if (generated) {
    return getStoredImageSrc(generated);
  }
  return conversation.referenceImages?.[0]?.dataUrl ?? null;
}

function getModeLabel(mode?: ImageConversation["mode"]) {
  return mode === "edit" ? "编辑图" : "文生图";
}

export function ImageSidebar({
  conversations,
  isLoadingHistory,
  generatingIds,
  selectedConversationId,
  collapsed,
  onToggleCollapsed,
  onSelectConversation,
  onDeleteConversation,
  formatConversationTime,
}: ImageSidebarProps) {
  return (
    <aside
      className={cn(
        "overflow-hidden rounded-[24px] border border-stone-200 bg-[#f8f8f7] shadow-[0_8px_30px_rgba(15,23,42,0.04)] transition-[width] duration-200 sm:rounded-[28px] dark:border-slate-700/75 dark:bg-slate-900/64 dark:shadow-[0_18px_60px_rgba(0,0,0,0.22)]",
        collapsed ? "w-full xl:w-[92px]" : "w-full",
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-stone-200/80 px-3 py-3 sm:px-4 sm:py-4 dark:border-slate-700/70">
          <div className={cn("gap-3", collapsed ? "flex items-center justify-between xl:flex-col xl:items-center" : "flex items-start justify-between")}>
            <div className={cn(collapsed ? "flex min-w-0 items-center gap-3 xl:flex-col xl:items-center xl:gap-2" : "min-w-0") }>
              <div className="flex size-11 items-center justify-center rounded-2xl bg-white shadow-sm dark:bg-slate-800/78">
                <History className="size-5 text-stone-600 dark:text-cyan-200" />
              </div>
              {collapsed ? (
                <div className="min-w-0 xl:hidden">
                  <h2 className="text-base font-semibold tracking-tight text-stone-900 dark:text-slate-100">历史记录</h2>
                  <p className="mt-0.5 truncate text-xs text-stone-500 dark:text-slate-400">{conversations.length} 条会话</p>
                </div>
              ) : (
                <>
                  <h2 className="mt-3 text-lg font-semibold tracking-tight text-stone-900 dark:text-slate-100">历史记录</h2>
                  <p className="mt-1 hidden text-sm text-stone-500 sm:block dark:text-slate-400">保留带图缩略图、提示词摘要和生成状态。</p>
                </>
              )}
            </div>

            <button
              type="button"
              className="inline-flex size-10 items-center justify-center rounded-2xl border border-stone-200 bg-white text-stone-600 transition hover:bg-stone-50 hover:text-stone-900 dark:border-slate-700/75 dark:bg-slate-800/78 dark:text-slate-300 dark:hover:bg-slate-700 dark:hover:text-slate-100"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? "展开历史记录" : "收起历史记录"}
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </div>

        </div>

        <div className={cn("hide-scrollbar min-h-0 flex-1 overflow-y-auto py-2 sm:py-3", collapsed ? "hidden px-2 xl:block" : "px-2")}>
          {isLoadingHistory ? (
            <div className={cn("flex items-center text-sm text-stone-500 dark:text-slate-400", collapsed ? "justify-center px-0 py-3" : "gap-2 rounded-2xl px-3 py-3")}>
              <LoaderCircle className="size-4 animate-spin" />
              {!collapsed ? "正在读取会话记录" : null}
            </div>
          ) : conversations.length === 0 ? (
            <div className={cn("text-sm leading-6 text-stone-500 dark:text-slate-400", collapsed ? "px-2 py-4 text-center text-xs" : "px-3 py-4")}>
              {collapsed ? "暂无" : "还没有历史记录。创建第一条图片任务后，会在这里保留缩略图和提示词摘要。"}
            </div>
          ) : (
            <div className="grid gap-2 sm:block sm:space-y-2">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedConversationId;
                const generating = generatingIds.has(conversation.id);
                const previewSrc = buildConversationPreviewSrc(conversation);

                return (
                  <div
                    key={conversation.id}
                    className={cn(
                      "group rounded-[22px] border transition",
                      collapsed ? "p-1.5" : "p-2",
                      active
                        ? "border-stone-200 bg-white shadow-sm dark:border-cyan-300/28 dark:bg-slate-800/86"
                        : "border-transparent bg-transparent hover:border-stone-200/80 hover:bg-white/70 dark:hover:border-slate-700/75 dark:hover:bg-slate-800/58",
                    )}
                  >
                    <div className={cn("flex", collapsed ? "flex-col items-center gap-1" : "items-center gap-3")}>
                      <button
                        type="button"
                        onClick={() => onSelectConversation(conversation.id)}
                        className={cn(collapsed ? "flex w-full flex-col items-center gap-1 text-center" : "flex min-w-0 flex-1 items-center gap-3 text-left")}
                        title={collapsed ? conversation.title : undefined}
                      >
                        <div className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-stone-100 dark:bg-slate-700/80", collapsed ? "size-14" : "size-14")}>
                          {previewSrc ? (
                            <img src={previewSrc} alt={conversation.title} className="h-full w-full object-cover" />
                          ) : (
                            <History className="size-4 text-stone-400 dark:text-slate-400" />
                          )}
                        </div>

                        {!collapsed ? (
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:bg-slate-700/78 dark:text-slate-300">
                                {getModeLabel(conversation.mode)}
                              </span>
                              {generating ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-400/12 dark:text-amber-200">
                                  <LoaderCircle className="size-3 animate-spin" />
                                  处理中
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-2 truncate text-sm font-medium text-stone-800 dark:text-slate-100">{conversation.title}</div>
                            <div className="mt-1 line-clamp-2 text-xs leading-5 text-stone-500 dark:text-slate-400">
                              {conversation.prompt || "无额外提示词"}
                            </div>
                            <div className="mt-2 text-[11px] text-stone-400 dark:text-slate-500">{formatConversationTime(conversation.createdAt)}</div>
                          </div>
                        ) : generating ? (
                          <LoaderCircle className="size-3.5 animate-spin text-amber-600" />
                        ) : null}
                      </button>

                      {!collapsed ? (
                        <button
                          type="button"
                          onClick={() => void onDeleteConversation(conversation.id)}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl text-stone-400 opacity-100 transition hover:bg-stone-100 hover:text-rose-500 lg:opacity-0 lg:group-hover:opacity-100 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-rose-300"
                          aria-label="删除会话"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
