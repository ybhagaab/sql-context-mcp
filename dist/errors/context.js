"use strict";
/**
 * Facts about where and how an error happened, attached to the error object without changing it.
 *
 * Errors pass through several layers (the driver, the pool, the retry loop, the runner). Each
 * layer adds what it knows, and the error description reads it all at the end. A WeakMap keeps
 * the thrown objects themselves unchanged, so callers that compare or re-throw them see the
 * original error.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.annotate = annotate;
exports.setContext = setContext;
exports.contextOf = contextOf;
const contexts = new WeakMap();
function isObject(value) {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
/** Adds facts that aren't known yet; facts recorded closer to the failure win. Returns `err`. */
function annotate(err, facts) {
    if (!isObject(err))
        return err;
    const current = contexts.get(err) ?? {};
    const merged = { ...current };
    for (const [key, value] of Object.entries(facts)) {
        if (value !== undefined && merged[key] === undefined)
            merged[key] = value;
    }
    contexts.set(err, merged);
    return err;
}
/** Records facts, replacing earlier values (for counts that the outer layers know best). Returns `err`. */
function setContext(err, facts) {
    if (!isObject(err))
        return err;
    const merged = { ...(contexts.get(err) ?? {}) };
    for (const [key, value] of Object.entries(facts)) {
        if (value !== undefined)
            merged[key] = value;
    }
    contexts.set(err, merged);
    return err;
}
function contextOf(err) {
    return isObject(err) ? contexts.get(err) ?? {} : {};
}
