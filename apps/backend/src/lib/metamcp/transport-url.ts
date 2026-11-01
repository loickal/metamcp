/** Preserve the existing non-OAuth Docker localhost mapping. */
export const transformDockerUrl = (url: string): string => {
  if (process.env.TRANSFORM_LOCALHOST_TO_DOCKER_INTERNAL === "true") {
    return url.replace(/localhost|127\.0\.0\.1/g, "host.docker.internal");
  }
  return url;
};
