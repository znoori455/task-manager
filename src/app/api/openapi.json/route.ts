import { openApiDocument } from "@/contract/openapi";

export const GET = () => Response.json(openApiDocument());
