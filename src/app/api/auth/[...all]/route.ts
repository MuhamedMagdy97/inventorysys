import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";

// Better Auth endpoints: sign-in/out, session, two-factor, api-key (doc 02 §6).
export const { GET, POST } = toNextJsHandler(auth);
