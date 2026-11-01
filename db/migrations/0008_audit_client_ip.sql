-- Phase 7: record WHERE an operator action came from.
-- Behind a gateway the socket address is the proxy's, so the value stored here is only meaningful
-- when the API is configured to trust exactly that proxy (TRUST_PROXY); otherwise it is the
-- proxy's own address, never a value a client can choose.
ALTER TABLE audit_log
  ADD COLUMN client_ip text CHECK (client_ip IS NULL OR length(client_ip) <= 64);
