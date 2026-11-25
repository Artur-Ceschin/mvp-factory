// Locale-aware user-facing messages and money formatting.
// The app's locale comes from APP_LOCALE (set from the idea spec): "en-US" (default) or "pt-BR".
// CORE FILE — generated apps must not edit anything under src/core.

export type Locale = "en-US" | "pt-BR";

export const locale = (): Locale => (process.env.APP_LOCALE === "pt-BR" ? "pt-BR" : "en-US");

const messages = {
  "en-US": {
    invalid_email: "Invalid email address",
    weak_password: "Password must be at least 8 characters",
    email_taken: "This email is already registered",
    rate_limited: "Too many attempts. Please try again later.",
    invalid_credentials: "Incorrect email or password",
    unauthorized: "Please log in to continue",
    payment_required: "This is a Pro feature",
    billing_disabled: "Payments are not set up yet",
    already_pro: "You are already subscribed",
    pluggy_disabled: "Bank connection is not set up yet",
    pluggy_auth: "Could not authenticate with the bank aggregator",
    pluggy_error: "The bank aggregator request failed",
    internal: "Something went wrong",
  },
  "pt-BR": {
    invalid_email: "E-mail inválido",
    weak_password: "A senha precisa ter pelo menos 8 caracteres",
    email_taken: "Este e-mail já está cadastrado",
    rate_limited: "Muitas tentativas. Tente novamente mais tarde.",
    invalid_credentials: "E-mail ou senha incorretos",
    unauthorized: "Faça login para continuar",
    payment_required: "Recurso do plano Pro",
    billing_disabled: "Pagamentos ainda não configurados",
    already_pro: "Você já é assinante",
    pluggy_disabled: "Conexão bancária ainda não configurada",
    pluggy_auth: "Falha ao autenticar no agregador bancário",
    pluggy_error: "Falha na requisição ao agregador bancário",
    internal: "Erro interno",
  },
} satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof messages)["en-US"];

/** Translated core message for the app's locale. */
export function t(key: MessageKey): string {
  return messages[locale()][key];
}

/** Formats integer cents in the app's locale, e.g. formatMoney(1299, "usd") → "$12.99". */
export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(locale(), { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
