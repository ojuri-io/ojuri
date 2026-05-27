import crypto, { randomUUID } from "crypto";

export const GetRandomID = (maxLength: number = 30): string => {
  const id = randomUUID();
  const cleaned = id.replaceAll("-", `${Math.floor(Math.random() * 100)}`);

  return cleaned.substring(0, maxLength);
};

export const GetUUID = (): string => randomUUID();

export const createSha512Hash = (data: any, key: string) => {
  const hash = crypto.createHmac("sha512", key).update(JSON.stringify(data)).digest("hex");

  return hash;
};

export const convertKeysToCamelCase = (obj: unknown): unknown => {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysToCamelCase(item));
  }

  const camelCasedObj: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (key.length === 0) continue;
      const camelKey = key[0]!.toLowerCase() + key.slice(1);
      camelCasedObj[camelKey] = convertKeysToCamelCase((obj as Record<string, unknown>)[key]);
    }
  }
  return camelCasedObj;
};

export const formatAmountForDisplay = (amount: number, currency: string): string => {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: currency }).format(amount);
};
