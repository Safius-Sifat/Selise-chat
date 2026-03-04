import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [tailwindcss(), sveltekit()],



    preview: {
        port: 4173,
        allowedHosts: ['selise.notice.fit'] // <--- Add this line
    },
    // If you are running in dev mode (npm run dev), use this instead:
    server: {
        allowedHosts: ['selise.notice.fit']
    }
});
