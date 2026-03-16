/**
 * Cloudflare expression fields registry.
 *
 * Reference: https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/
 *
 * MAINTAINER NOTE: To add a new field, add it to the FIELDS array below.
 * To deprecate a field, set `deprecated: true` and `replacement` to the new field name.
 */

import type { FieldType } from './operators.js';

export interface FieldDef {
  /** Full dotted field name (e.g., "http.request.uri.path") */
  name: string;
  /** Value type */
  type: FieldType;
  /** Whether this field is deprecated */
  deprecated?: boolean;
  /** Suggested replacement field for deprecated fields */
  replacement?: string;
  /** Phases where this field is available. Empty array = all phases. */
  phases?: string[];
  /** Human-readable notes */
  notes?: string;
}

/**
 * Master field registry.
 *
 * Phases key:
 *   - Empty phases array or undefined = available in all phases
 *   - Specific phase names = only available in those phases
 *
 * Response fields are only available in response phases.
 */
export const FIELDS: FieldDef[] = [
  // ── HTTP Request URI Fields ──────────────────────────────────────────
  { name: 'http.request.uri', type: 'String' },
  { name: 'http.request.uri.path', type: 'String' },
  { name: 'http.request.uri.path.extension', type: 'String' },
  { name: 'http.request.uri.query', type: 'String' },
  { name: 'http.request.uri.args', type: 'Map' },
  { name: 'http.request.uri.args.names', type: 'Array' },
  { name: 'http.request.uri.args.values', type: 'Array' },
  { name: 'http.request.full_uri', type: 'String' },
  { name: 'http.request.method', type: 'String' },
  { name: 'http.request.version', type: 'String' },

  // ── HTTP Request Header Fields ───────────────────────────────────────
  { name: 'http.request.headers', type: 'Map' },
  { name: 'http.request.headers.names', type: 'Array' },
  { name: 'http.request.headers.values', type: 'Array' },
  { name: 'http.request.headers.truncated', type: 'Boolean' },
  { name: 'http.request.accepted_languages', type: 'Array' },

  // ── HTTP Request Cookie Fields ───────────────────────────────────────
  { name: 'http.request.cookies', type: 'Map' },

  // ── HTTP Request Body Fields ─────────────────────────────────────────
  { name: 'http.request.body.raw', type: 'String' },
  { name: 'http.request.body.size', type: 'Integer' },
  { name: 'http.request.body.truncated', type: 'Boolean' },
  { name: 'http.request.body.mime', type: 'String' },
  { name: 'http.request.body.form', type: 'Map' },
  { name: 'http.request.body.form.names', type: 'Array' },
  { name: 'http.request.body.form.values', type: 'Array' },
  { name: 'http.request.body.multipart', type: 'Map' },
  { name: 'http.request.body.multipart.content_dispositions', type: 'Array' },
  { name: 'http.request.body.multipart.content_transfer_encodings', type: 'Array' },
  { name: 'http.request.body.multipart.content_types', type: 'Array' },
  { name: 'http.request.body.multipart.filenames', type: 'Array' },
  { name: 'http.request.body.multipart.names', type: 'Array' },
  { name: 'http.request.body.multipart.values', type: 'Array' },

  // ── HTTP Request Timestamp Fields ────────────────────────────────────
  { name: 'http.request.timestamp.sec', type: 'Integer' },
  { name: 'http.request.timestamp.msec', type: 'Integer' },

  // ── HTTP Request JWT Fields ──────────────────────────────────────────
  { name: 'http.request.jwt.claims', type: 'Map' },
  { name: 'http.request.jwt.claims.aud', type: 'Array' },
  { name: 'http.request.jwt.claims.aud.names', type: 'Array' },
  { name: 'http.request.jwt.claims.aud.values', type: 'Array' },
  { name: 'http.request.jwt.claims.iat.sec', type: 'Array' },
  { name: 'http.request.jwt.claims.iat.sec.names', type: 'Array' },
  { name: 'http.request.jwt.claims.iat.sec.values', type: 'Array' },
  { name: 'http.request.jwt.claims.iss', type: 'Array' },
  { name: 'http.request.jwt.claims.iss.names', type: 'Array' },
  { name: 'http.request.jwt.claims.iss.values', type: 'Array' },
  { name: 'http.request.jwt.claims.jti', type: 'Array' },
  { name: 'http.request.jwt.claims.jti.names', type: 'Array' },
  { name: 'http.request.jwt.claims.jti.values', type: 'Array' },
  { name: 'http.request.jwt.claims.nbf.sec', type: 'Array' },
  { name: 'http.request.jwt.claims.nbf.sec.names', type: 'Array' },
  { name: 'http.request.jwt.claims.nbf.sec.values', type: 'Array' },
  { name: 'http.request.jwt.claims.sub', type: 'Array' },
  { name: 'http.request.jwt.claims.sub.names', type: 'Array' },
  { name: 'http.request.jwt.claims.sub.values', type: 'Array' },

  // ── HTTP Convenience Fields ──────────────────────────────────────────
  { name: 'http.cookie', type: 'String' },
  { name: 'http.host', type: 'String' },
  { name: 'http.referer', type: 'String' },
  { name: 'http.user_agent', type: 'String' },
  { name: 'http.x_forwarded_for', type: 'String' },

  // ── HTTP Response Fields (response phases only) ──────────────────────
  { name: 'http.response.code', type: 'Integer', phases: [
    'http_ratelimit',
    'http_response_headers_transform', 'http_custom_errors',
    'http_response_compression', 'http_response_firewall_managed',
    'http_log_custom_fields',
  ]},
  { name: 'http.response.content_type.media_type', type: 'String', phases: [
    'http_ratelimit',
    'http_response_headers_transform', 'http_custom_errors',
    'http_response_compression', 'http_response_firewall_managed',
    'http_log_custom_fields',
  ]},
  { name: 'http.response.headers', type: 'Map', phases: [
    'http_ratelimit',
    'http_response_headers_transform', 'http_custom_errors',
    'http_response_compression', 'http_response_firewall_managed',
    'http_log_custom_fields',
  ]},
  { name: 'http.response.headers.names', type: 'Array', phases: [
    'http_ratelimit',
    'http_response_headers_transform', 'http_custom_errors',
    'http_response_compression', 'http_response_firewall_managed',
    'http_log_custom_fields',
  ]},
  { name: 'http.response.headers.values', type: 'Array', phases: [
    'http_ratelimit',
    'http_response_headers_transform', 'http_custom_errors',
    'http_response_compression', 'http_response_firewall_managed',
    'http_log_custom_fields',
  ]},

  // ── IP / Geolocation Fields ──────────────────────────────────────────
  { name: 'ip.src', type: 'IP' },
  { name: 'ip.src.asnum', type: 'Integer' },
  { name: 'ip.src.city', type: 'String' },
  { name: 'ip.src.continent', type: 'String' },
  { name: 'ip.src.country', type: 'String' },
  { name: 'ip.src.is_in_european_union', type: 'Boolean' },
  { name: 'ip.src.lat', type: 'Float' },
  { name: 'ip.src.lon', type: 'Float' },
  { name: 'ip.src.metro_code', type: 'Integer' },
  { name: 'ip.src.postal_code', type: 'String' },
  { name: 'ip.src.region', type: 'String' },
  { name: 'ip.src.region_code', type: 'String' },
  { name: 'ip.src.subdivision_1_iso_code', type: 'String' },
  { name: 'ip.src.subdivision_2_iso_code', type: 'String' },
  { name: 'ip.src.timezone.name', type: 'String' },

  // ── Deprecated ip.geoip.* aliases ────────────────────────────────────
  { name: 'ip.geoip.asnum', type: 'Integer', deprecated: true, replacement: 'ip.src.asnum' },
  { name: 'ip.geoip.city', type: 'String', deprecated: true, replacement: 'ip.src.city' },
  { name: 'ip.geoip.continent', type: 'String', deprecated: true, replacement: 'ip.src.continent' },
  { name: 'ip.geoip.country', type: 'String', deprecated: true, replacement: 'ip.src.country' },
  { name: 'ip.geoip.is_in_european_union', type: 'Boolean', deprecated: true, replacement: 'ip.src.is_in_european_union' },
  { name: 'ip.geoip.subdivision_1_iso_code', type: 'String', deprecated: true, replacement: 'ip.src.subdivision_1_iso_code' },
  { name: 'ip.geoip.subdivision_2_iso_code', type: 'String', deprecated: true, replacement: 'ip.src.subdivision_2_iso_code' },

  // ── SSL/TLS Fields ───────────────────────────────────────────────────
  { name: 'ssl', type: 'Boolean' },
  { name: 'cf.tls_version', type: 'String' },
  { name: 'cf.tls_cipher', type: 'String' },
  { name: 'cf.tls_ciphers_sha1', type: 'String' },
  { name: 'cf.tls_client_hello_length', type: 'Integer' },
  { name: 'cf.tls_client_random', type: 'String' },
  { name: 'cf.tls_client_extensions_sha1', type: 'String' },
  { name: 'cf.tls_client_extensions_sha1_le', type: 'String' },

  // ── mTLS Client Auth Fields ──────────────────────────────────────────
  { name: 'cf.tls_client_auth.cert_fingerprint_sha1', type: 'String' },
  { name: 'cf.tls_client_auth.cert_fingerprint_sha256', type: 'String' },
  { name: 'cf.tls_client_auth.cert_issuer_dn', type: 'String' },
  { name: 'cf.tls_client_auth.cert_issuer_dn_legacy', type: 'String' },
  { name: 'cf.tls_client_auth.cert_issuer_dn_rfc2253', type: 'String' },
  { name: 'cf.tls_client_auth.cert_issuer_serial', type: 'String' },
  { name: 'cf.tls_client_auth.cert_issuer_ski', type: 'String' },
  { name: 'cf.tls_client_auth.cert_not_after', type: 'String' },
  { name: 'cf.tls_client_auth.cert_not_before', type: 'String' },
  { name: 'cf.tls_client_auth.cert_presented', type: 'Boolean' },
  { name: 'cf.tls_client_auth.cert_revoked', type: 'Boolean' },
  { name: 'cf.tls_client_auth.cert_serial', type: 'String' },
  { name: 'cf.tls_client_auth.cert_ski', type: 'String' },
  { name: 'cf.tls_client_auth.cert_subject_dn', type: 'String' },
  { name: 'cf.tls_client_auth.cert_subject_dn_legacy', type: 'String' },
  { name: 'cf.tls_client_auth.cert_subject_dn_rfc2253', type: 'String' },
  { name: 'cf.tls_client_auth.cert_verified', type: 'Boolean' },

  // ── Bot Management Fields ────────────────────────────────────────────
  { name: 'cf.bot_management.corporate_proxy', type: 'Boolean' },
  { name: 'cf.bot_management.detection_ids', type: 'Array' },
  { name: 'cf.bot_management.ja3_hash', type: 'String' },
  { name: 'cf.bot_management.ja4', type: 'String' },
  { name: 'cf.bot_management.js_detection.passed', type: 'Boolean' },
  { name: 'cf.bot_management.score', type: 'Integer' },
  { name: 'cf.bot_management.static_resource', type: 'Boolean' },
  { name: 'cf.bot_management.verified_bot', type: 'Boolean' },
  { name: 'cf.client.bot', type: 'Boolean' },
  { name: 'cf.verified_bot_category', type: 'String' },

  // ── WAF Fields ───────────────────────────────────────────────────────
  { name: 'cf.waf.auth_detected', type: 'Boolean' },
  { name: 'cf.waf.content_scan.has_failed', type: 'Boolean' },
  { name: 'cf.waf.content_scan.has_malicious_obj', type: 'Boolean' },
  { name: 'cf.waf.content_scan.has_obj', type: 'Boolean' },
  { name: 'cf.waf.content_scan.num_malicious_obj', type: 'Integer' },
  { name: 'cf.waf.content_scan.num_obj', type: 'Integer' },
  { name: 'cf.waf.content_scan.obj_results', type: 'Array' },
  { name: 'cf.waf.content_scan.obj_sizes', type: 'Array' },
  { name: 'cf.waf.content_scan.obj_types', type: 'Array' },
  { name: 'cf.waf.credential_check.password_leaked', type: 'Boolean' },
  { name: 'cf.waf.credential_check.username_and_password_leaked', type: 'Boolean' },
  { name: 'cf.waf.credential_check.username_leaked', type: 'Boolean' },
  { name: 'cf.waf.credential_check.username_password_similar', type: 'Boolean' },
  { name: 'cf.waf.score', type: 'Integer' },
  { name: 'cf.waf.score.class', type: 'String' },
  { name: 'cf.waf.score.rce', type: 'Integer' },
  { name: 'cf.waf.score.sqli', type: 'Integer' },
  { name: 'cf.waf.score.xss', type: 'Integer' },

  // ── Edge / Network Fields ────────────────────────────────────────────
  { name: 'cf.edge.server_ip', type: 'IP' },
  { name: 'cf.edge.server_port', type: 'Integer' },
  { name: 'cf.edge.client_port', type: 'Integer' },
  { name: 'cf.edge.client_tcp', type: 'Boolean' },

  // ── Cloudflare Metadata Fields ───────────────────────────────────────
  { name: 'cf.hostname.metadata', type: 'String' },
  { name: 'cf.ray_id', type: 'String' },
  { name: 'cf.random_seed', type: 'Bytes' },
  { name: 'cf.zone.name', type: 'String' },
  { name: 'cf.zone.plan', type: 'String' },
  { name: 'cf.metal.id', type: 'String' },

  // ── Threat / Timing Fields ───────────────────────────────────────────
  { name: 'cf.threat_score', type: 'Integer' },
  { name: 'cf.timings.client_tcp_rtt_msec', type: 'Integer' },
  { name: 'cf.timings.edge_msec', type: 'Integer' },
  { name: 'cf.timings.origin_ttfb_msec', type: 'Integer' },

  // ── Response Error Fields ────────────────────────────────────────────
  { name: 'cf.response.1xxx_code', type: 'Integer', phases: [
    'http_custom_errors', 'http_response_headers_transform',
  ]},
  { name: 'cf.response.error_type', type: 'String', phases: [
    'http_custom_errors', 'http_response_headers_transform',
  ]},

  // ── API Gateway Fields ───────────────────────────────────────────────
  { name: 'cf.api_gateway.auth_id_present', type: 'Boolean' },
  { name: 'cf.api_gateway.fallthrough_detected', type: 'Boolean' },
  { name: 'cf.api_gateway.request_violates_schema', type: 'Boolean' },

  // ── LLM Security Fields ──────────────────────────────────────────────
  { name: 'cf.llm.prompt.custom_topic_categories', type: 'Map' },
  { name: 'cf.llm.prompt.detected', type: 'Boolean' },
  { name: 'cf.llm.prompt.injection_score', type: 'Integer' },
  { name: 'cf.llm.prompt.pii_categories', type: 'Array' },
  { name: 'cf.llm.prompt.pii_detected', type: 'Boolean' },
  { name: 'cf.llm.prompt.token_count', type: 'Integer' },
  { name: 'cf.llm.prompt.unsafe_topic_categories', type: 'Array' },
  { name: 'cf.llm.prompt.unsafe_topic_detected', type: 'Boolean' },

  // ── Worker Fields ────────────────────────────────────────────────────
  { name: 'cf.worker.upstream_zone', type: 'Boolean' },

  // ── Raw (untransformed) Fields ───────────────────────────────────────
  { name: 'raw.http.request.full_uri', type: 'String' },
  { name: 'raw.http.request.uri', type: 'String' },
  { name: 'raw.http.request.uri.path', type: 'String' },
  { name: 'raw.http.request.uri.path.extension', type: 'String' },
  { name: 'raw.http.request.uri.query', type: 'String' },
  { name: 'raw.http.request.uri.args', type: 'Map' },
  { name: 'raw.http.request.uri.args.names', type: 'Array' },
  { name: 'raw.http.request.uri.args.values', type: 'Array' },
  { name: 'raw.http.request.headers', type: 'Map' },
  { name: 'raw.http.request.headers.names', type: 'Array' },
  { name: 'raw.http.request.headers.values', type: 'Array' },
  { name: 'raw.http.response.headers', type: 'Map', phases: [
    'http_response_headers_transform',
  ]},
  { name: 'raw.http.response.headers.names', type: 'Array', phases: [
    'http_response_headers_transform',
  ]},
  { name: 'raw.http.response.headers.values', type: 'Array', phases: [
    'http_response_headers_transform',
  ]},
];

/** Build a lookup map for fast field resolution */
const fieldMap = new Map<string, FieldDef>();
for (const field of FIELDS) {
  fieldMap.set(field.name, field);
}

/**
 * Look up a field by name.
 * Returns undefined if the field is not recognized.
 */
export function findField(name: string): FieldDef | undefined {
  return fieldMap.get(name);
}

/**
 * Check if a field name could be a dynamic map/array access.
 * E.g., "http.request.headers" is a Map field, so "http.request.headers["host"]" is valid.
 * Returns the base field if found.
 */
export function findBaseField(name: string): FieldDef | undefined {
  // Direct match first
  const direct = fieldMap.get(name);
  if (direct) return direct;

  // Try progressively shorter prefixes for map/array access
  const parts = name.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.');
    const field = fieldMap.get(prefix);
    if (field && (field.type === 'Map' || field.type === 'Array')) {
      return field;
    }
  }
  return undefined;
}
