import type { Context } from "hono";
import { env } from "hono/adapter";
import type { MiddlewareHandler } from "hono/types";
import { createRemoteJWKSet, type JWTHeaderParameters, type JWTPayload, jwtVerify } from "jose";

import { HTTPException } from "../utils/http-exception";

export type Auth0JwtEnv = {
	AUTH0_DOMAIN: string;
	AUTH0_AUDIENCE: string;
};

export const jwt = (
	options?: {
		auth0_domain: string;
		auth0_audience: string;
	},
	_init?: RequestInit,
): MiddlewareHandler => {
	let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

	return async function jwt(ctx, next) {
		const auth0Env = env<Auth0JwtEnv>(ctx);

		const { auth0_domain: raw_auth0_domain, auth0_audience } = options || {
			auth0_audience: auth0Env.AUTH0_AUDIENCE,
			auth0_domain: auth0Env.AUTH0_DOMAIN,
		};

		let normalizedDomain = raw_auth0_domain || "";
		if (normalizedDomain.startsWith("https://")) {
			normalizedDomain = normalizedDomain.substring(8);
		}
		if (normalizedDomain.endsWith("/")) {
			normalizedDomain = normalizedDomain.substring(0, normalizedDomain.length - 1);
		}

		const auth0_domain = normalizedDomain;
		if (!auth0_domain || auth0_domain.length === 0) {
			throw new Error('JWT auth middleware requires options "auth0_domain"');
		}
		if (!auth0_audience || auth0_audience.length === 0) {
			throw new Error('JWT auth middleware requires options "auth0_audience"');
		}

		const credentials = ctx.req.raw.headers.get("Authorization");
		if (!credentials) {
			const errDescription = "No Authorization header included in request";
			throw new HTTPException(401, {
				message: errDescription,
				res: unauthorizedResponse({
					ctx,
					errDescription,
					error: "invalid_request",
				}),
			});
		}

		const parts = credentials.split(/\s+/);
		if (parts.length !== 2) {
			const errDescription = "Invalid Authorization header structure";
			throw new HTTPException(401, {
				message: errDescription,
				res: unauthorizedResponse({
					ctx,
					errDescription,
					error: "invalid_request",
				}),
			});
		}

		if (parts[0] !== "Bearer") {
			const errDescription =
				"Invalid authorization header (only Bearer tokens are supported)";
			throw new HTTPException(401, {
				message: errDescription,
				res: unauthorizedResponse({
					ctx,
					errDescription: errDescription,
					error: "invalid_request",
				}),
			});
		}

		if (!JWKS) {
			JWKS = createRemoteJWKSet(new URL(`https://${auth0_domain}/.well-known/jwks.json`));
		}

		const token = parts[1];
		if (!token || token.length === 0) {
			const errDescription = "No token included in request";
			throw new HTTPException(401, {
				message: errDescription,
				res: unauthorizedResponse({
					ctx,
					errDescription,
					error: "invalid_request",
				}),
			});
		}

		let payload: JWTPayload | null = null;
		let protectedHeader: JWTHeaderParameters | null = null;
		let cause: Error | null = null;
		try {
			const verified = await jwtVerify(token, JWKS, {
				audience: auth0_audience,
				issuer: `https://${auth0_domain}/`,
			});
			payload = verified.payload;
			protectedHeader = verified.protectedHeader;
		} catch (e) {
			cause = e as Error;
		}

		if (!payload) {
			if (cause instanceof Error && cause.constructor === Error) {
				throw cause;
			}
			throw new HTTPException(401, {
				cause,
				message: "Unauthorized",
				res: unauthorizedResponse({
					ctx,
					errDescription: "Token verification failure",
					error: "invalid_token",
					statusText: "Unauthorized",
				}),
			});
		}

		ctx.set("jwtPayload", payload);
		ctx.set("jwtProtectedHeader", protectedHeader);

		await next();
	};
};

function unauthorizedResponse(opts: {
	ctx: Context;
	error: string;
	errDescription: string;
	statusText?: string;
}) {
	return new Response("Unauthorized", {
		headers: {
			"WWW-Authenticate": `Bearer realm="${opts.ctx.req.url}",error="${opts.error}",error_description="${opts.errDescription}"`,
		},
		status: 401,
		statusText: opts.statusText,
	});
}

export function requireScope(scope: string): MiddlewareHandler {
	return async function requireScope(ctx, next) {
		const payload = ctx.var.jwtPayload as JWTPayload;
		if (!payload.scope) {
			throw new HTTPException(403, {
				message: "Forbidden",
				res: unauthorizedResponse({
					ctx,
					errDescription: `Missing required scope: ${scope}`,
					error: "insufficient_scope",
				}),
			});
		}

		const scopes = Array.isArray(payload.scope)
			? payload.scope
			: (payload.scope as string).split(" ");
		if (!scopes || !scopes.includes(scope)) {
			throw new HTTPException(403, {
				message: "Forbidden",
				res: unauthorizedResponse({
					ctx,
					errDescription: `Missing required scope: ${scope}`,
					error: "insufficient_scope",
				}),
			});
		}

		await next();
	};
}
