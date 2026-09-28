"use client";

import localforage from "localforage";

import type { ImageModel } from "@/lib/api";
import { httpRequest } from "@/lib/request";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

export type StoredImage = {
  id: string;
  status?: "loading" | "success" | "error";
  url?: string;
  b64_json?: string;
  error?: string;
  jobId?: string;
  progress?: string;
  progressText?: string;
  canResume?: boolean;
};

export type ImageGenerationSettings = {
  quality?: string;
  size?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
};

export type ImageConversationStatus = "generating" | "success" | "error";

export type ImageConversation = {
  id: string;
  title: string;
  prompt: string;
  model: ImageModel;
  mode?: ImageConversationMode;
  referenceImages?: StoredReferenceImage[];
  generationSettings?: ImageGenerationSettings;
  count: number;
  images: StoredImage[];
  createdAt: string;
  status: ImageConversationStatus;
  error?: string;
};

const imageConversationStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "image_conversations",
});

const IMAGE_CONVERSATIONS_KEY = "items";
const IMAGE_CONVERSATION_TOMBSTONES_KEY = "deleted_ids";

async function getDeletedConversationIds(): Promise<Set<string>> {
  const ids = (await imageConversationStorage.getItem<string[]>(IMAGE_CONVERSATION_TOMBSTONES_KEY)) || [];
  return new Set(ids.filter(Boolean));
}

async function addDeletedConversationId(id: string): Promise<void> {
  const deletedIds = await getDeletedConversationIds();
  deletedIds.add(id);
  await imageConversationStorage.setItem(IMAGE_CONVERSATION_TOMBSTONES_KEY, Array.from(deletedIds).slice(-2000));
}

async function removeDeletedConversationId(id: string): Promise<void> {
  const deletedIds = await getDeletedConversationIds();
  if (!deletedIds.delete(id)) {
    return;
  }
  await imageConversationStorage.setItem(IMAGE_CONVERSATION_TOMBSTONES_KEY, Array.from(deletedIds));
}

function normalizeStoredImage(image: StoredImage): StoredImage {
  if (image.status === "loading" || image.status === "error" || image.status === "success") {
    return image;
  }
  return {
    ...image,
    status: image.url || image.b64_json ? "success" : "loading",
  };
}

export function getStoredImageSrc(image: StoredImage): string | null {
  if (image.url) {
    return image.url;
  }
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  return null;
}

function normalizeConversation(conversation: ImageConversation): ImageConversation {
  return {
    ...conversation,
    mode: conversation.mode === "edit" ? "edit" : "generate",
    images: (conversation.images || []).map(normalizeStoredImage),
  };
}

async function listRemoteImageConversations(): Promise<ImageConversation[]> {
  const data = await httpRequest<{ items: ImageConversation[] }>("/v1/image-conversations?limit=500", {
    authScope: "user",
  });
  return (data.items || []).map(normalizeConversation).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function saveRemoteImageConversation(conversation: ImageConversation): Promise<void> {
  await httpRequest<{ success: boolean; conversation: ImageConversation }>("/v1/image-conversations", {
    method: "POST",
    body: { conversation: normalizeConversation(conversation) },
    authScope: "user",
  });
}

export async function listImageConversations(): Promise<ImageConversation[]> {
  const deletedIds = await getDeletedConversationIds();
  const localItems = ((await imageConversationStorage.getItem<ImageConversation[]>(IMAGE_CONVERSATIONS_KEY)) || [])
    .map(normalizeConversation)
    .filter((item) => !deletedIds.has(item.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  try {
    const remoteItems = (await listRemoteImageConversations()).filter((item) => !deletedIds.has(item.id));
    const remoteIds = new Set(remoteItems.map((item) => item.id));
    const localOnlyItems = localItems.filter((item) => !remoteIds.has(item.id));

    if (localOnlyItems.length > 0) {
      await Promise.allSettled(localOnlyItems.map((item) => saveRemoteImageConversation(item)));
    }

    const merged = [...remoteItems, ...localOnlyItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await imageConversationStorage.setItem(IMAGE_CONVERSATIONS_KEY, merged);
    return merged;
  } catch {
    return localItems;
  }
}

export async function saveImageConversation(conversation: ImageConversation): Promise<void> {
  await removeDeletedConversationId(conversation.id);
  const items = await listImageConversations();
  const nextItems = [normalizeConversation(conversation), ...items.filter((item) => item.id !== conversation.id)];
  nextItems.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await imageConversationStorage.setItem(IMAGE_CONVERSATIONS_KEY, nextItems);
  try {
    await saveRemoteImageConversation(conversation);
  } catch {
    // Keep the local copy; the next history load will retry syncing local-only items.
  }
}

export async function deleteImageConversation(id: string): Promise<void> {
  const items = await listImageConversations();
  await addDeletedConversationId(id);
  await imageConversationStorage.setItem(
    IMAGE_CONVERSATIONS_KEY,
    items.filter((item) => item.id !== id),
  );
  try {
    await httpRequest<{ success: boolean }>(`/v1/image-conversations/${id}`, {
      method: "DELETE",
      authScope: "user",
    });
  } catch {
    // Local deletion should still complete if the network is temporarily unavailable.
  }
}

export async function clearImageConversations(): Promise<void> {
  const items = await listImageConversations();
  const deletedIds = await getDeletedConversationIds();
  items.forEach((item) => deletedIds.add(item.id));
  await imageConversationStorage.setItem(IMAGE_CONVERSATION_TOMBSTONES_KEY, Array.from(deletedIds).slice(-2000));
  await imageConversationStorage.removeItem(IMAGE_CONVERSATIONS_KEY);
  try {
    await httpRequest<{ success: boolean; deleted: number }>("/v1/image-conversations", {
      method: "DELETE",
      authScope: "user",
    });
  } catch {
    // Local clear should not be blocked by a transient backend failure.
  }
}
