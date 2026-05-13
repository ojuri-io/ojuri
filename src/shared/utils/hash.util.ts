import * as bcrypt from "bcrypt";

const SALT_ROUNDS = 10;

export const bcryptHashString = async (text: string) => {
  return await bcrypt.hash(text, SALT_ROUNDS);
};

export const bcryptCompareHashedString = async (plainText: string, hashedText: string) => {
  return await bcrypt.compare(plainText, hashedText);
};
