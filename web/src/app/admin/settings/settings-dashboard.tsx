"use client";

import { useEffect, useRef } from "react";

import { AccountPoolPolicyCard } from "@/app/settings/components/account-pool-policy-card";
import { CPAPoolDialog } from "@/app/settings/components/cpa-pool-dialog";
import { CPAPoolsCard } from "@/app/settings/components/cpa-pools-card";
import { ImageUpstreamsCard } from "@/app/settings/components/image-upstreams-card";
import { PromptOptimizerCard } from "@/app/settings/components/prompt-optimizer-card";
import { EditableStudioCard } from "@/app/settings/components/editable-studio-card";
import { ImportBrowserDialog } from "@/app/settings/components/import-browser-dialog";
import { ProxySettingsCard } from "@/app/settings/components/proxy-settings-card";
import { QuickPromptsCard } from "@/app/settings/components/quick-prompts-card";
import { RegisterEmailSettingsCard } from "@/app/settings/components/register-email-settings-card";
import { SettingsHeader } from "@/app/settings/components/settings-header";
import { SiteBrandingCard } from "@/app/settings/components/site-branding-card";
import { Sub2APIConnections } from "@/app/settings/components/sub2api-connections";
import { UserQuotaCard } from "@/app/settings/components/user-quota-card";
import { useSettingsStore } from "@/app/settings/store";

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadPools = useSettingsStore((state) => state.loadPools);
  const pools = useSettingsStore((state) => state.pools);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const hasRunningJobs = pools.some((pool) => {
      const status = pool.import_job?.status;
      return status === "pending" || status === "running";
    });
    if (!hasRunningJobs) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPools(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadPools, pools]);

  return null;
}

export default function SettingsPage() {
  return (
    <>
      <SettingsDataController />
      <SettingsHeader />
      <section className="space-y-6">
        <SiteBrandingCard />
        <ProxySettingsCard />
        <UserQuotaCard />
        <RegisterEmailSettingsCard />
        <AccountPoolPolicyCard />
        <QuickPromptsCard />
        <PromptOptimizerCard />
        <EditableStudioCard />
        <ImageUpstreamsCard />
        <CPAPoolsCard />
        <Sub2APIConnections />
      </section>
      <CPAPoolDialog />
      <ImportBrowserDialog />
    </>
  );
}
