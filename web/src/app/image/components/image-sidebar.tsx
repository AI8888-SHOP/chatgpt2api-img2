"use client";

import { History, LoaderCircle, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { getStoredImageSrc, type ImageConversation } from "@/store/image-conversations";

type ImageSidebarProps = {
  conversations: ImageConversation[]; isLoadingHistory: boolean; generatingIds: Set<string>;
  selectedConversationId: string | null; collapsed: boolean; onToggleCollapsed: () => void;
  onSelectConversation: (id: string) => void; onDeleteConversation: (id: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string; onNewConversation?: () => void;
};

export function ImageSidebar({ conversations, isLoadingHistory, generatingIds, selectedConversationId, collapsed, onToggleCollapsed, onSelectConversation, onDeleteConversation, formatConversationTime, onNewConversation }: ImageSidebarProps) {
  return <aside className={"studio-sidebar " + (collapsed ? "is-collapsed" : "")} aria-label="历史记录">
    <div className="studio-sidebar-heading"><span><History size={17} />{!collapsed && "最近对话"}</span><button type="button" className="studio-icon-button" onClick={onToggleCollapsed} aria-label={collapsed ? "展开历史记录" : "收起历史记录"} aria-expanded={!collapsed}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
    {onNewConversation && <button type="button" className="studio-new-conversation" onClick={onNewConversation} aria-label="新建对话"><Plus size={17} />{!collapsed && "新建对话"}</button>}
    {!collapsed && <nav className="studio-sidebar-nav" aria-label="创作工具"><Link href="/image" aria-current="page">画图工作台</Link><Link href="/editable-files">PPT / PSD</Link></nav>}
    <div className="studio-history-list overflow-y-auto">
      {isLoadingHistory ? <div className="studio-history-empty"><LoaderCircle size={17} className="animate-spin" />{!collapsed && "正在读取会话记录"}</div> : !conversations.length ? <p className="studio-history-empty">{collapsed ? "暂无" : "你的创作会保存在这里"}</p> : conversations.map(conversation => {
        const active = conversation.id === selectedConversationId;
        const generating = generatingIds.has(conversation.id);
        const generated = conversation.images.find(image => getStoredImageSrc(image));
        const src = generated ? getStoredImageSrc(generated) : conversation.referenceImages?.[0]?.dataUrl;
        return <div key={conversation.id} className="studio-history-item" data-active={active}>
          <button type="button" className="studio-history-select" onClick={() => onSelectConversation(conversation.id)} aria-label={conversation.title || "未命名对话"} title={conversation.title || "未命名对话"} aria-current={active ? "true" : undefined}>
            <span className="studio-history-thumb">{src ? <img src={src} alt="" loading="lazy" /> : <History size={16} />}</span>
            {!collapsed && <span className="studio-history-text"><span>{conversation.title || "未命名对话"}</span><small>{generating ? "生成中…" : formatConversationTime(conversation.createdAt)}</small></span>}
            {generating && <LoaderCircle size={12} className="shrink-0 animate-spin" />}
          </button>
          {!collapsed && <button type="button" className="studio-history-delete studio-icon-button" aria-label="删除会话" onClick={() => void onDeleteConversation(conversation.id)}><Trash2 size={14} /></button>}
        </div>;
      })}
    </div>
    {!collapsed && <Link href="/api-keys" className="studio-sidebar-account">个人中心 · 积分与账户</Link>}
  </aside>;
}
