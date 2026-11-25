/**
 * Known credential formats. Every pattern is anchored so it cannot match in the
 * middle of an ordinary word. Order matters: the first pattern to claim a value names it.
 */
export interface SecretPattern {
  id: string;
  name: string;
  pattern: RegExp;
}

const B = "(?<![A-Za-z0-9_-])";

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: "private-key-block", name: "Private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "anthropic-api-key", name: "Anthropic API key", pattern: new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{20,}`) },
  { id: "openai-api-key", name: "OpenAI API key", pattern: new RegExp(`${B}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`) },
  { id: "google-api-key", name: "Google API key", pattern: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`) },
  { id: "google-oauth-token", name: "Google OAuth access token", pattern: new RegExp(`${B}ya29\\.[0-9A-Za-z_-]{20,}`) },
  { id: "aws-access-key-id", name: "AWS access key ID", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  { id: "github-token", name: "GitHub token", pattern: new RegExp(`${B}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})`) },
  { id: "gitlab-token", name: "GitLab token", pattern: new RegExp(`${B}glpat-[A-Za-z0-9_-]{20,}`) },
  { id: "slack-token", name: "Slack token", pattern: new RegExp(`${B}xox[baprs]-[A-Za-z0-9-]{10,}`) },
  { id: "stripe-key", name: "Stripe API key", pattern: new RegExp(`${B}(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`) },
  { id: "sendgrid-key", name: "SendGrid API key", pattern: new RegExp(`${B}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`) },
  { id: "npm-token", name: "npm token", pattern: new RegExp(`${B}npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])`) },
  { id: "huggingface-token", name: "Hugging Face token", pattern: new RegExp(`${B}hf_[A-Za-z0-9]{30,}`) },
  { id: "jwt", name: "JSON Web Token", pattern: new RegExp(`${B}eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`) },
  { id: "slack-webhook", name: "Slack webhook URL", pattern: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{8,}/ },
  { id: "discord-webhook", name: "Discord webhook URL", pattern: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{8,}/ },
];

export interface SecretHit {
  id: string;
  name: string;
}

/** Returns the kinds of credential found in the text. Never returns the matched value. */
export function scanForSecrets(text: string, allow: readonly string[] = []): SecretHit[] {
  const hits: SecretHit[] = [];
  let remaining = text;
  for (const { id, name, pattern } of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    if (!global.test(remaining)) continue;
    // A claimed value is blanked so a broader pattern below does not report it twice.
    remaining = remaining.replace(global, " ");
    if (!allow.includes(id)) hits.push({ id, name });
  }
  return hits;
}

export class SecretFoundError extends Error {
  constructor(
    readonly stepNumber: number,
    readonly caption: string,
    readonly hits: SecretHit[],
  ) {
    const kinds = hits.map((h) => `${h.name} (${h.id})`).join(", ");
    super(
      `Step ${stepNumber} (“${caption}”) would capture a likely credential: ${kinds}. ` +
        `Nothing was written. Cover it with the "mask" option, swap it with "replace", ` +
        `or list the id under "allowSecrets" if it is not a real credential.`,
    );
    this.name = "SecretFoundError";
  }
}
