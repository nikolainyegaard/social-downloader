// Image variants, one command for all of them (see CLAUDE.md):
//   docker buildx bake dev --push
//   BUILD_VERSION=v1.5.2 docker buildx bake release --push
//
// The bare tag is the CPU build for amd64 and arm64. The -cuda12 and -cuda13
// tags carry the onnxruntime CUDA build for that CUDA major (amd64 only, the
// NVIDIA wheels have no arm64 build); the suffix names the driver series the
// host needs, 550 for cuda12 and 580 or newer for cuda13.

variable "IMAGE"         { default = "ghcr.io/nikolainyegaard/social-downloader" }
variable "BUILD_VERSION" { default = "dev" }

group "default" { targets = ["dev"] }
group "dev"     { targets = ["cpu", "cuda12", "cuda13"] }
group "release" { targets = ["cpu-release", "cuda12-release", "cuda13-release"] }

target "_base" {
  context    = "."
  dockerfile = "Dockerfile"
  args       = { BUILD_VERSION = BUILD_VERSION }
}

target "cpu" {
  inherits  = ["_base"]
  platforms = ["linux/amd64", "linux/arm64"]
  tags      = ["${IMAGE}:dev"]
}

target "cuda12" {
  inherits  = ["_base"]
  platforms = ["linux/amd64"]
  args      = { CUDA = "12" }
  tags      = ["${IMAGE}:dev-cuda12"]
}

target "cuda13" {
  inherits  = ["_base"]
  platforms = ["linux/amd64"]
  args      = { CUDA = "13" }
  tags      = ["${IMAGE}:dev-cuda13"]
}

target "cpu-release" {
  inherits = ["cpu"]
  tags     = ["${IMAGE}:latest", "${IMAGE}:${BUILD_VERSION}"]
}

target "cuda12-release" {
  inherits = ["cuda12"]
  tags     = ["${IMAGE}:latest-cuda12", "${IMAGE}:${BUILD_VERSION}-cuda12"]
}

target "cuda13-release" {
  inherits = ["cuda13"]
  tags     = ["${IMAGE}:latest-cuda13", "${IMAGE}:${BUILD_VERSION}-cuda13"]
}
