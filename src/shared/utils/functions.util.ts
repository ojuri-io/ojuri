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

export const convertKeysToCamelCase = (obj: Object) => {
  if (typeof obj !== "object" || obj === null) {
    return obj; // Return as is for non-object values
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => convertKeysToCamelCase(item));
  }

  const camelCasedObj = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const camelKey = key[0].toLowerCase() + key.slice(1); // Convert the first character to lowercase
      camelCasedObj[camelKey] = convertKeysToCamelCase(obj[key]);
    }
  }
  return camelCasedObj;
};

export const formatAmountForDisplay = (amount: number, currency: string): string => {
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: currency }).format(amount);
};
