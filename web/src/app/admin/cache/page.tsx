"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, Image as ImageIcon, LoaderCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  deleteAdminGeneratedImages,
  fetchAdminGeneratedImages,
  type GeneratedImageCacheItem,
} from "@/lib/api";

function formatAction(action: string) {
  return (
    {
      image_generate: "文生图",
      image_edit: "编辑图",
      chat_image_completion: "Chat 兼容",
      responses_image_generation: "Responses 兼容",
    }[action] || action || "未标记"
  );
}

function formatDate(value: number) {
  if (!value) {
    return "—";
  }
  return new Date(value * 1000).toLocaleString("zh-CN");
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

export default function AdminCachePage() {
  const didLoadRef = useRef(false);
  const [items, setItems] = useState<GeneratedImageCacheItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("60");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [total, setTotal] = useState(0);
  const [totalSize, setTotalSize] = useState(0);

  const currentPageSize = Number(pageSize) || 60;
  const pageCount = Math.max(1, Math.ceil(total / currentPageSize));
  const safePage = Math.min(page, pageCount);

  const loadItems = async (silent = false, targetPage = page) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const data = await fetchAdminGeneratedImages({
        query: query.trim(),
        action: actionFilter,
        limit: currentPageSize,
        offset: Math.max(0, targetPage - 1) * currentPageSize,
      });
      setItems(data.items);
      setTotal(data.total);
      setTotalSize(data.total_size_bytes);
      setSelectedIds((prev) => prev.filter((id) => data.items.some((item) => item.id === id)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载图片缓存失败";
      toast.error(message);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void loadItems();
  }, []);

  useEffect(() => {
    if (!didLoadRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      setPage(1);
      void loadItems(true, 1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, actionFilter]);

  useEffect(() => {
    if (!didLoadRef.current) {
      return;
    }
    void loadItems(true);
  }, [page, pageSize]);

  const allSelected = useMemo(
    () => items.length > 0 && items.every((item) => selectedIds.includes(item.id)),
    [items, selectedIds],
  );

  const handleToggleAll = (checked: boolean) => {
    setSelectedIds(checked ? items.map((item) => item.id) : []);
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) {
      toast.error("请先选择图片");
      return;
    }
    const confirmed = window.confirm(`确认删除当前选中的 ${selectedIds.length} 张图片？`);
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      const data = await deleteAdminGeneratedImages(selectedIds);
      await loadItems(true);
      setSelectedIds([]);
      toast.success(`已删除 ${data.deleted} 张图片`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除图片失败";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteSingle = async (id: string) => {
    const confirmed = window.confirm("确认删除这张缓存图片？");
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      const data = await deleteAdminGeneratedImages([id]);
      await loadItems(true);
      setSelectedIds((prev) => prev.filter((item) => item !== id));
      toast.success(`已删除 ${data.deleted} 张图片`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除图片失败";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 py-6 sm:px-6">
      <section className="grid gap-4 md:grid-cols-3">
        <Card className="border-stone-200/70 bg-white/90 shadow-sm">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="rounded-2xl bg-stone-100 p-3 text-stone-700">
              <ImageIcon className="size-5" />
            </div>
            <div>
              <div className="text-sm text-stone-500">缓存图片总数</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{total}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-stone-200/70 bg-white/90 shadow-sm">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="rounded-2xl bg-sky-50 p-3 text-sky-600">
              <HardDrive className="size-5" />
            </div>
            <div>
              <div className="text-sm text-stone-500">占用空间</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{formatBytes(totalSize)}</div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-stone-200/70 bg-white/90 shadow-sm">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="rounded-2xl bg-amber-50 p-3 text-amber-600">
              <Trash2 className="size-5" />
            </div>
            <div>
              <div className="text-sm text-stone-500">当前已选</div>
              <div className="mt-1 text-3xl font-semibold tracking-tight text-stone-900">{selectedIds.length}</div>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card className="border-stone-200/70 bg-white/95 shadow-sm">
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索提示词、模型、文件名、密钥名"
                className="pl-9"
              />
            </div>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-full lg:w-[180px]">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                <SelectItem value="image_generate">文生图</SelectItem>
                <SelectItem value="image_edit">编辑图</SelectItem>
                <SelectItem value="chat_image_completion">Chat 兼容</SelectItem>
                <SelectItem value="responses_image_generation">Responses 兼容</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={pageSize}
              onValueChange={(value) => {
                setPageSize(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full lg:w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24">24 条/页</SelectItem>
                <SelectItem value="60">60 条/页</SelectItem>
                <SelectItem value="120">120 条/页</SelectItem>
                <SelectItem value="200">200 条/页</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={() => void loadItems()} disabled={isLoading}>
              {isLoading ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              刷新
            </Button>
            <Button variant="destructive" onClick={() => void handleDeleteSelected()} disabled={isDeleting || selectedIds.length === 0}>
              {isDeleting ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <Trash2 className="mr-2 size-4" />}
              删除选中
            </Button>
          </div>

          <div className="flex items-center gap-3 text-sm text-stone-500">
            <Checkbox checked={allSelected} onCheckedChange={(checked) => handleToggleAll(Boolean(checked))} />
            <span>全选当前页</span>
            <span>
              第 {safePage} / {pageCount} 页，共 {total} 张
            </span>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex min-h-[280px] items-center justify-center text-stone-500">
          <LoaderCircle className="mr-2 size-5 animate-spin" />
          正在加载图片缓存...
        </div>
      ) : items.length === 0 ? (
        <Card className="border-dashed border-stone-200 bg-white/80">
          <CardContent className="flex min-h-[260px] flex-col items-center justify-center gap-3 text-center text-stone-500">
            <ImageIcon className="size-8" />
            <div className="text-lg font-medium text-stone-700">暂无图片缓存</div>
            <div className="max-w-md text-sm leading-6">这里会显示服务器上保存的生图结果，支持后台集中查看和批量删除。</div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {items.map((item) => {
              const checked = selectedIds.includes(item.id);
              return (
                <Card key={item.id} className="overflow-hidden border-stone-200/80 bg-white shadow-sm">
                  <div className="relative aspect-square bg-stone-100">
                    <img src={item.url} alt={item.prompt || item.file_name} className="h-full w-full object-cover" />
                    <div className="absolute top-3 left-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(nextChecked) => {
                          setSelectedIds((prev) =>
                            nextChecked ? [...prev, item.id] : prev.filter((id) => id !== item.id),
                          );
                        }}
                        className="bg-white/90"
                      />
                    </div>
                    <div className="absolute top-3 right-3">
                      <Badge variant="secondary" className="bg-black/65 text-white hover:bg-black/65">
                        {formatAction(item.action)}
                      </Badge>
                    </div>
                  </div>
                  <CardContent className="space-y-3 p-4">
                    <div className="line-clamp-3 min-h-[66px] text-sm leading-6 text-stone-700">
                      {item.prompt || "历史图片，暂无提示词记录"}
                    </div>
                    <div className="space-y-1 text-xs leading-5 text-stone-500">
                      <div>模型：{item.model || "—"}</div>
                      <div>密钥：{item.api_key_name || item.api_key || "—"}</div>
                      <div>文件：{item.file_name}</div>
                      <div>时间：{formatDate(item.created_at)}</div>
                      <div>大小：{formatBytes(item.size_bytes)}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" asChild>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          查看原图
                        </a>
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        disabled={isDeleting}
                        onClick={() => void handleDeleteSingle(item.id)}
                      >
                        删除
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <div className="flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white/90 px-4 py-3 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
            <div>
              第 {safePage} / {pageCount} 页，当前显示 {items.length} 张，共 {total} 张
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                className="h-8 rounded-lg border-stone-200 bg-white px-3 text-xs"
                disabled={page >= pageCount}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >
                下一页
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
