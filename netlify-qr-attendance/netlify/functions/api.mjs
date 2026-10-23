// Netlify Function (v2). Every request to /api/* lands here.
import { getStore } from "@netlify/blobs";
import { handle } from "./lib/core.mjs";

export default async (req) => {
  // "strong" consistency: a student's check-in is visible to the instructor immediately.
  const store = getStore({ name: "attendance", consistency: "strong" });
  return handle(req, { store, env: process.env });
};

export const config = { path: "/api/*" };
