import {appConfig, type MailProviderName} from "./config.js";
import {createCloudflareProvider} from "./mail/cloudflare.js";
import {createGmailProvider} from "./mail/gmail.js";
import {createHotmailProvider} from "./mail/hotmail.js";
import {createPythonBridgeProvider} from "./mail/python-bridge.js";

type MailboxState = Record<string, string>;

export interface EmailCodeProvider {
  getEmailAddress(username?: string): Promise<string>;
  getEmailVerificationCode(email: string): Promise<string>;
  createMailbox?(username?: string): Promise<MailboxState>;
  getMailboxVerificationCode?(mailbox: MailboxState): Promise<string>;
  getAliasSuffix?(): string;
  setAliasSuffix?(suffix: string): Promise<void>;
  getRandomAliasEnabled?(): boolean;
  setRandomAliasEnabled?(enabled: boolean): void;
  getMailApiMode?(): string;
  setMailApiMode?(mode: string): void;
  markEmailUsed?(email: string): void;
  clearUsedEmails?(): void;
  clearAccountCache?(): void;
  createAbortController?(): AbortController;
  abortRegistration?(): void;
  getAbortSignal?(): AbortSignal | undefined;
  prepareOtpBaseline?(email: string): Promise<boolean | void>;
  markVerificationCodeRejected?(email: string, code: string): void;
  clearOtpPollState?(email: string): void;
}

export const MAILBOX_CONFIG: {
  provider: MailProviderName;
} = {
  provider: appConfig.provider,
};

function createProvider(): EmailCodeProvider {
  switch (MAILBOX_CONFIG.provider) {
    case "gmail":
      return createGmailProvider();
    case "hotmail":
      return createHotmailProvider();
    case "cloudflare":
      return createCloudflareProvider();
    case "cloudflare_temp_email":
    case "tempmail_lol":
    case "duckmail":
    case "gptmail":
    case "moemail":
    case "yyds_mail":
      return createPythonBridgeProvider();
    default:
      throw new Error(`不支持的邮箱 provider: ${MAILBOX_CONFIG.provider}`);
  }
}

const provider = createProvider();
const mailboxByEmail = new Map<string, MailboxState>();

export async function getEmailAddress(username?: string): Promise<string> {
  if (provider.createMailbox) {
    const mailbox = await provider.createMailbox(username);
    if (!mailbox.address) {
      throw new Error("邮箱 Provider 缺少 address");
    }
    mailboxByEmail.set(mailbox.address.toLowerCase(), mailbox);
    return mailbox.address;
  }
  return provider.getEmailAddress(username);
}

export async function getEmailVerificationCode(email: string): Promise<string> {
  const mailbox = mailboxByEmail.get(String(email ?? "").trim().toLowerCase());
  if (mailbox && provider.getMailboxVerificationCode) {
    return provider.getMailboxVerificationCode(mailbox);
  }
  return provider.getEmailVerificationCode(email);
}

export async function prepareOtpBaseline(email: string): Promise<void> {
  await provider.prepareOtpBaseline?.(email);
}

export function markVerificationCodeRejected(email: string, code: string): void {
  provider.markVerificationCodeRejected?.(email, code);
}

export function clearOtpPollState(email: string): void {
  provider.clearOtpPollState?.(email);
}

export function getAliasSuffix(): string {
  return provider.getAliasSuffix?.() ?? "";
}

export async function setAliasSuffix(suffix: string): Promise<void> {
  await provider.setAliasSuffix?.(suffix);
}

export function getRandomAliasEnabled(): boolean {
  return provider.getRandomAliasEnabled?.() ?? false;
}

export function setRandomAliasEnabled(enabled: boolean): void {
  provider.setRandomAliasEnabled?.(enabled);
}

export function getMailApiMode(): string {
  return provider.getMailApiMode?.() ?? "";
}

export function setMailApiMode(mode: string): void {
  provider.setMailApiMode?.(mode);
}

export function markEmailUsed(email: string): void {
  provider.markEmailUsed?.(email);
}

export function clearUsedEmails(): void {
  provider.clearUsedEmails?.();
}

export function clearAccountCache(): void {
  provider.clearAccountCache?.();
}

export function createAbortController(): AbortController {
  return provider.createAbortController?.() ?? new AbortController();
}

export function abortRegistration(): void {
  provider.abortRegistration?.();
}

export function getAbortSignal(): AbortSignal | undefined {
  return provider.getAbortSignal?.();
}
