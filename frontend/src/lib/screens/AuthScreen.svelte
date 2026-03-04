<script lang="ts">
    import type { AuthMode } from "$lib/types/chat";

    export let authMode: AuthMode = "signin";
    export let signEmail = "";
    export let signPassword = "";
    export let signName = "";
    export let authLoading = false;
    export let authError = "";

    export let onSwitchMode: (mode: AuthMode) => void;
    export let onSubmit: () => void;
</script>

<div class="mx-auto flex h-full w-full max-w-md items-center justify-center">
    <div class="card w-full border border-base-300 bg-base-100 shadow-xl">
        <div class="card-body gap-4">
            <div class="flex items-center justify-between gap-2">
                <h1 class="text-2xl font-bold">PocketChat</h1>
                <div role="tablist" class="tabs tabs-box bg-base-200 p-1">
                    <button
                        class={`tab ${authMode === "signin" ? "tab-active" : ""}`}
                        on:click={() => onSwitchMode("signin")}
                    >
                        Sign in
                    </button>
                    <button
                        class={`tab ${authMode === "signup" ? "tab-active" : ""}`}
                        on:click={() => onSwitchMode("signup")}
                    >
                        Sign up
                    </button>
                </div>
            </div>

            <p class="text-sm text-base-content/70">
                WhatsApp-like messaging powered by PocketBase authentication and storage.
            </p>

            <div class="grid w-full gap-3">
                {#if authMode === "signup"}
                    <label class="form-control w-full gap-1">
                        <span class="label-text text-sm">Name</span>
                        <input
                            class="input input-bordered w-full"
                            bind:value={signName}
                            placeholder="Your name"
                        />
                    </label>
                {/if}

                <label class="form-control w-full gap-1">
                    <span class="label-text text-sm">Email</span>
                    <input
                        class="input input-bordered w-full"
                        bind:value={signEmail}
                        type="email"
                        placeholder="hello@example.com"
                    />
                </label>

                <label class="form-control w-full gap-1">
                    <span class="label-text text-sm">Password</span>
                    <input
                        class="input input-bordered w-full"
                        bind:value={signPassword}
                        type="password"
                        placeholder="••••••••"
                    />
                </label>
            </div>

            {#if authError}
                <div class="alert alert-error py-2 text-sm">{authError}</div>
            {/if}

            <button class="btn btn-primary w-full" disabled={authLoading} on:click={onSubmit}>
                {authLoading
                    ? "Please wait..."
                    : authMode === "signin"
                      ? "Sign in"
                      : "Create account"}
            </button>
        </div>
    </div>
</div>
