CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_payment_id TEXT UNIQUE,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB',
  plan_code TEXT,
  payment_kind TEXT NOT NULL DEFAULT 'initial' CHECK (payment_kind IN ('initial', 'recurring')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'expired', 'cancelled')),
  provider TEXT,
  provider_subscription_id TEXT,
  plan_code TEXT,
  card_token TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  next_charge_at TIMESTAMPTZ,
  charge_attempt_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_due_idx ON subscriptions (next_charge_at) WHERE card_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  referral_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_visitors (
  visitor_hash TEXT PRIMARY KEY,
  partner_id UUID NOT NULL REFERENCES referral_partners(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_visit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_hash TEXT NOT NULL,
  partner_id UUID NOT NULL REFERENCES referral_partners(id),
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_attributions (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  partner_id UUID NOT NULL REFERENCES referral_partners(id),
  attached_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES referral_partners(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE TABLE IF NOT EXISTS referral_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES referral_partners(id),
  user_id UUID NOT NULL REFERENCES users(id),
  payment_id UUID NOT NULL UNIQUE REFERENCES payments(id),
  gross_minor INTEGER NOT NULL CHECK (gross_minor >= 0),
  commission_minor INTEGER NOT NULL CHECK (commission_minor >= 0),
  payout_id UUID REFERENCES referral_payouts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_visitors_expiry_idx ON referral_visitors (expires_at);
CREATE INDEX IF NOT EXISTS referral_visit_events_partner_idx ON referral_visit_events (partner_id, clicked_at);
CREATE INDEX IF NOT EXISTS referral_commissions_partner_idx ON referral_commissions (partner_id, created_at);
