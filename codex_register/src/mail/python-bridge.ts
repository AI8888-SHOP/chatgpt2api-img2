import path from "node:path";
import {spawn} from "node:child_process";

type MailboxState = Record<string, string>;

const BRIDGE_SCRIPT = "/app/utils/mail_provider_bridge.py";
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";

function runBridge<T>(action: "create_mailbox" | "wait_for_code", payload: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            PYTHON_BIN,
            [BRIDGE_SCRIPT, action, path.resolve(process.cwd(), "config.json")],
            {
                cwd: process.cwd(),
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            reject(error);
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(
                    new Error(
                        `mail_provider_bridge ${action} failed: code=${code} stderr=${stderr.trim().slice(0, 500)} stdout=${stdout.trim().slice(0, 500)}`,
                    ),
                );
                return;
            }
            try {
                resolve(JSON.parse(stdout) as T);
            } catch (error) {
                reject(
                    new Error(
                        `mail_provider_bridge ${action} returned invalid json: ${stdout.trim().slice(0, 500)} (${error instanceof Error ? error.message : String(error)})`,
                    ),
                );
            }
        });

        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

export function createPythonBridgeProvider() {
    return {
        async getEmailAddress(username?: string) {
            const result = await runBridge<{mailbox: MailboxState}>("create_mailbox", {
                username,
            });
            const address = String(result.mailbox?.address ?? "").trim();
            if (!address) {
                throw new Error("Python mail provider 返回的 mailbox 缺少 address");
            }
            return address;
        },
        async getEmailVerificationCode(email: string) {
            throw new Error(`Python mail provider 需要 mailbox 状态读取验证码: ${email}`);
        },
        async createMailbox(username?: string) {
            const result = await runBridge<{mailbox: MailboxState}>("create_mailbox", {
                username,
            });
            if (!result.mailbox || typeof result.mailbox !== "object") {
                throw new Error("Python mail provider create_mailbox 返回结构错误");
            }
            return result.mailbox;
        },
        async getMailboxVerificationCode(mailbox: MailboxState) {
            const result = await runBridge<{code?: string | null; mailbox?: MailboxState}>("wait_for_code", {mailbox});
            if (result.mailbox && typeof result.mailbox === "object") {
                Object.assign(mailbox, result.mailbox);
            }
            const code = String(result.code ?? "").trim();
            if (!code) {
                throw new Error(`邮箱中未找到验证码: targetEmail=${String(mailbox.address ?? "").trim()}`);
            }
            return code;
        },
    };
}
