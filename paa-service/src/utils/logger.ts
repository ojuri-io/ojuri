import pino from "pino";
import appConfig from "@config/app.config";

const logger = pino({
  name: appConfig.app.name,
  level: process.env.LOG_LEVEL || "info",
  enabled: appConfig.app.env !== "test",
  transport:
    appConfig.app.env === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        }
      : undefined,
});

export default logger;
