import pino from "pino";
import config from "../../../config/app.config";

const logger = pino({
  enabled: config.app.env !== "test",
  mixin() {
    return {
      service: config.app.name,
    };
  },
  serializers: {
    req(req) {
      return {
        method: req.method,
        headers: req.headers,
        ip: req.ip,
        url: req.url,
        path: req.path,
        params: req.params,
        query: req.query,
        body: req.body,
      };
    },
    res(res) {
      return {
        statusCode: res.raw.statusCode,
        headers: res.getHeaders(),
        body: res.raw.payload,
      };
    },
    err(err) {
      return {
        id: err.id,
        type: err.type,
        code: err.code,
        message: err.message,
        stack: err.stack,
      };
    },
  },
  // Hide sensitive fields from structured logs. The predict request
  // body contains sender/receiver IDs and amounts — useful at debug
  // level for individual operators, but a privacy concern when piped
  // into a long-term log store. Adopters in regulated jurisdictions
  // can extend this list via env var if they have a stricter policy.
  redact: [
    "req.body.password",
    "req.body.currentPassword",
    "req.body.newPassword",
    "req.headers.authorization",
    "req.headers['x-api-key']",
    "req.headers.cookie",
    "req.body.sender_id",
    "req.body.receiver_id",
    "req.body.amount",
    "req.body.customer_id_number",
    "req.body.recipient_id_number",
    "req.body.customer_dob",
    "req.body.recipient_dob",
  ],
});

export default logger;
