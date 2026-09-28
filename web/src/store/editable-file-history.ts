"use client";

import localforage from "localforage";

import type { EditableFileKind } from "@/lib/api";

export type EditableFileDraft = {
  prompt?: string;
  images?: string[];
  title?: string;
};

const editableFileStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "editable_file_history",
});

const draftsKey = (kind: EditableFileKind) => `drafts:${kind}`;
const deletedKey = (kind: EditableFileKind) => `deleted:${kind}`;

export async function listEditableFileDrafts(kind: EditableFileKind): Promise<Record<string, EditableFileDraft>> {
  return (await editableFileStorage.getItem<Record<string, EditableFileDraft>>(draftsKey(kind))) || {};
}

export async function saveEditableFileDrafts(kind: EditableFileKind, drafts: Record<string, EditableFileDraft>): Promise<void> {
  await editableFileStorage.setItem(draftsKey(kind), drafts);
}

export async function listDeletedEditableFileIds(kind: EditableFileKind): Promise<Set<string>> {
  return new Set((await editableFileStorage.getItem<string[]>(deletedKey(kind))) || []);
}

export async function saveDeletedEditableFileIds(kind: EditableFileKind, ids: Set<string>): Promise<void> {
  await editableFileStorage.setItem(deletedKey(kind), [...ids]);
}
