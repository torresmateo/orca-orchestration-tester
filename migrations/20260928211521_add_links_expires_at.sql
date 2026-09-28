-- C2. Optional expiry (issue #5). NULL means the link never expires. Once
-- now() reaches expires_at, GET /<slug> answers 410 expired instead of 302.
alter table links add column expires_at timestamptz;
