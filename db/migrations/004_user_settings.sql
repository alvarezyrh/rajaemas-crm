-- =====================================================================
-- 004_user_settings — account settings & staff user management
-- =====================================================================
ALTER TABLE users
  -- set when an admin creates the account or resets its password: the user
  -- must choose their own password before doing anything else
  ADD COLUMN must_change_password boolean     NOT NULL DEFAULT false,
  ADD COLUMN password_changed_at  timestamptz,
  ADD COLUMN last_login_at        timestamptz,
  ADD COLUMN updated_at           timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE INDEX users_role_idx ON users (role, is_active);
