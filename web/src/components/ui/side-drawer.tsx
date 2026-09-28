"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

// Use a modal portal so drawers cannot be clipped by layout containers.
// Radix also provides Escape, focus trapping/restoration, and body scroll lock.
export function SideDrawer({ open, onOpenChange, title, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-stone-950/30 backdrop-blur-[2px]" />
        <Dialog.Content aria-describedby={undefined} className="fixed bottom-2 left-2 top-2 z-[60] flex w-[min(90vw,360px)] min-h-0 flex-col overflow-hidden rounded-[24px] border border-white/70 bg-[#fbfaf7] shadow-xl outline-none">
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
