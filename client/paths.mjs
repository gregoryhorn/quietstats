export const publicBase = import.meta.env.BASE_URL;
export const hosted = publicBase !== "/";
export const appPath = (path = "/") => publicBase + path.replace(/^\//, "");
export const pagePath = (path) => "/" + path.slice(publicBase.length);
