#!/bin/bash
set -e
pnpm install --frozen-lockfile
# push-force, not push: post-merge runs with stdin closed, so an interactive
# drizzle-kit confirmation prompt would hang until the timeout kills it.
pnpm --filter db run push-force
