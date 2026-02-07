import { expect, test } from '@playwright/test';

test('renders TUI frontend and action buttons', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CHERRIKKA LOCAL CONVERTER' })).toBeVisible();
  await expect(page.getByRole('button', { name: '[1] INSPECT' })).toBeVisible();
  await expect(page.getByRole('button', { name: '[2] VALIDATE' })).toBeVisible();
  await expect(page.getByRole('button', { name: '[3] CONVERT + DOWNLOAD' })).toBeVisible();
});
