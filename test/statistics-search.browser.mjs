// Synthetic-only browser checks. Import runBrowserChecks with a Playwright Page
// against the local built app; every expenses request is intercepted below.
export async function runBrowserChecks(page, baseURL, password) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) throw new Error('Synthetic browser tests require localhost');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const seen = [];
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    const now = new Date();
    const today = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const currentMonth = today.slice(0, 7).replace('/', '-');
    const makeData = prefix => [
        ...Array.from({ length: 55 }, (_, i) => ({ id: `shared-${Math.floor(i / 2)}`, date: today, merchant: `${prefix} 架空店舗 ${i}`, amount: 100 + i, category: i % 2 ? '' : '食費', type: i === 54 ? undefined : 'Expense' })),
        { id: 'normalized', date: '2024/02/29', merchant: `${prefix} ＡＢＣ ｶﾌｪ`, amount: 400, category: '食費', type: 'Expense' },
        { id: 'income', date: today, merchant: `${prefix} 架空収入`, amount: 10000, category: '給与', type: 'Income' },
    ];
    const data = { main: makeData('家庭'), yahoo: makeData('個人') };
    let failed = false;
    let pause = false;
    let resume;
    let pending;
    const posts = [];
    const login = await page.request.post(`${baseURL}/api/auth/verify`, { data: { password } });
    check(login.status() === 200, 'real login issues session for synthetic test credentials');
    await page.route('**/api/expenses**', async route => {
        const request = route.request();
        if (request.method() === 'GET') {
            if (pause) { pending = new Promise(resolve => { resume = resolve; }); await pending; }
            if (failed) return route.fulfill({ status: 503, json: { error: 'synthetic failure' } });
            const source = new URL(request.url()).searchParams.get('source') === 'yahoo' ? 'yahoo' : 'main';
            return route.fulfill({ json: data[source] });
        }
        const body = request.postDataJSON();
        posts.push(body);
        const source = body.source === 'yahoo' ? 'yahoo' : 'main';
        const index = data[source].findIndex(item => item.id === body.id
            && item.date === (body.currentDate ?? body.date)
            && item.merchant === (body.currentMerchant ?? body.merchant)
            && item.amount === (body.currentAmount ?? body.amount));
        check(index >= 0, 'POST must strictly match a synthetic row');
        if (body.action === 'deleteTransaction') data[source].splice(index, 1);
        if (body.action === 'updateTransaction') data[source][index] = { ...data[source][index], ...(body.category !== undefined ? { category: body.category } : {}), ...(body.amount !== undefined ? { amount: body.amount } : {}) };
        if (body.action === 'updateTransactionDate') data[source][index].date = body.date;
        return route.fulfill({ json: { success: true } });
    });
    const shown = async (locator, name) => { await locator.getByText(name, { exact: true }).waitFor(); };
    const search = () => page.getByRole('region', { name: '支出検索', exact: true });
    const results = () => search().locator('li');
    const clear = () => search().getByRole('button', { name: '条件をクリア' }).click();
    const openSearch = async prefix => {
        await page.goto(`${baseURL}${prefix}/calendar`);
        await page.getByRole('button', { name: '支出検索', exact: true }).click();
        await results().first().waitFor();
    };
    const dialog = () => page.getByRole('dialog', { name: '明細詳細' });
    const close = () => dialog().getByRole('button', { name: '明細詳細を閉じる' }).click();
    const modalReachable = async () => {
        await dialog().waitFor();
        const before = posts.length;
        const button = dialog().getByRole('button', { name: 'この明細を削除', exact: true });
        await button.scrollIntoViewIfNeeded();
        check(await button.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight && element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), 'delete button is reachable and above bottom navigation');
        check(await dialog().evaluate(element => element.parentElement.parentElement === document.body), 'modal is portaled to body');
        check(await page.evaluate(() => document.body.style.position === 'fixed'), 'background scrolling locked');
        await button.click();
        await dialog().getByRole('button', { name: 'もう一度タップで削除' }).waitFor();
        check(posts.length === before, 'first delete tap must not post');
        await close();
        check(await page.evaluate(() => document.body.style.position !== 'fixed'), 'background lock restored');
    };

    await page.setViewportSize({ width: 390, height: 844 });
    for (const prefix of ['', '/yahoo']) {
        await page.goto(`${baseURL}${prefix}/statistics`);
        await page.getByRole('heading', { name: '統計', exact: true }).waitFor();
        await page.getByText('読み込み中…', { exact: true }).waitFor({ state: 'hidden' });
        const links = await page.locator('a').allTextContents();
        check(JSON.stringify(links) === JSON.stringify(['レポート', '統計', 'カレンダー', '管理']), 'tab ordering');
        check(await page.getByRole('button', { name: '全期間', exact: true }).getAttribute('aria-pressed') === 'true', 'default all period');
        await page.getByRole('button', { name: '年', exact: true }).click();
        check(await page.getByLabel('対象年').inputValue() === String(now.getFullYear()), 'year defaults current');
        await page.getByLabel('対象年').selectOption('2024');
        await page.getByText('集計値を表で確認', { exact: true }).click();
        await page.getByRole('rowheader', { name: '2024-02', exact: true }).waitFor();
        check(await page.locator('tbody tr').count() === 12, 'year zero-filled months');
        await page.getByRole('button', { name: '月', exact: true }).click();
        check(await page.getByLabel('対象月').inputValue() === currentMonth, 'month defaults current');
        await page.getByLabel('対象月').fill('2024-02');
        await page.getByRole('rowheader', { name: '2024-02-29', exact: true }).waitFor();
        check(await page.locator('tbody tr').count() === 29, 'leap month days');
        const chart = page.getByRole('region', { name: '収入・支出・収支グラフ' }).locator('.recharts-wrapper');
        await chart.click({ position: { x: 150, y: 100 } });
        await chart.locator('.recharts-tooltip-wrapper').waitFor();
        await page.getByRole('link', { name: 'カレンダー', exact: true }).click();
        await page.waitForURL(`${baseURL}${prefix}/calendar`);
        check(new URL(page.url()).pathname === `${prefix}/calendar`, 'source-specific calendar link');
        await page.getByRole('link', { name: '統計', exact: true }).click();
        await page.waitForURL(`${baseURL}${prefix}/statistics`);
        check(await page.getByRole('button', { name: '全期間', exact: true }).getAttribute('aria-pressed') === 'true', 'revisit resets all period');
        seen.push(`statistics ${prefix || 'main'}`);
    }

    for (const prefix of ['', '/yahoo']) {
        await openSearch(prefix);
        check(await results().count() === 50, 'first page has 50 rows');
        await search().getByRole('button', { name: 'もっと見る' }).click();
        check(await results().count() === 56, 'load more shows remaining rows; excludes income');
        const own = prefix ? '個人' : '家庭';
        const other = prefix ? '家庭' : '個人';
        check(!(await search().innerText()).includes(other), 'sources never mixed');
        await search().getByLabel('店舗名・内容').fill('  abc カフェ  ');
        await shown(search(), `${own} ＡＢＣ ｶﾌｪ`);
        await search().getByLabel('開始日').fill('2024-02-29');
        await search().getByLabel('終了日').fill('2024-02-29');
        await search().getByLabel('カテゴリ', { exact: true }).selectOption('食費');
        await search().getByLabel('最小金額').fill('400');
        await search().getByLabel('最大金額').fill('400');
        await shown(search(), '1件 · 支出合計 ¥400');
        await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
        await page.locator('header button').first().click();
        await page.waitForFunction(() => document.querySelectorAll('header h1').length === 1);
        const calendarMonth = await page.locator('header h1:visible').innerText();
        await page.getByRole('button', { name: '支出検索', exact: true }).click();
        check(await search().getByLabel('店舗名・内容').inputValue() === '  abc カフェ  ', 'search state preserved');
        for (const [type, x] of [['touchstart', 250], ['touchmove', 50], ['touchend', 50]]) {
            await search().getByLabel('店舗名・内容').evaluate((element, { type, x }) => {
                const event = new Event(type, { bubbles: true });
                Object.defineProperty(event, 'targetTouches', { value: [{ clientX: x }] });
                element.dispatchEvent(event);
            }, { type, x });
        }
        await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
        check(await page.locator('header h1:visible').innerText() === calendarMonth, 'calendar state preserved; search swipe does not change month');
        await page.getByRole('button', { name: '支出検索', exact: true }).click();
        await search().getByLabel('最大金額').fill('399');
        await shown(search(), '最大金額は最小金額以上にしてください');
        check(await results().count() === 0, 'invalid range suppresses results');
        await search().getByLabel('最大金額').fill('abc');
        await shown(search(), '0以上の正しい金額を入力してください');
        await clear();
        check(await results().count() === 50, 'clear resets pagination');
        await search().getByLabel('カテゴリ', { exact: true }).selectOption('未分類');
        check(await results().count() === 27, 'unclassified expenses');
        await clear();
        await search().getByLabel('店舗名・内容').fill('abc');
        await search().getByLabel('最小金額').fill('300');
        await results().first().getByRole('button').click();
        await dialog().locator('input[type="number"]').fill('200');
        await dialog().getByRole('button', { name: '金額を保存' }).click();
        await dialog().waitFor({ state: 'hidden' });
        await shown(search(), '該当する支出はありません');
        await search().getByLabel('最小金額').fill('');
        await shown(search(), '1件 · 支出合計 ¥200');
        await clear();
        await search().getByLabel('店舗名・内容').fill('abc');
        await search().getByLabel('カテゴリ', { exact: true }).selectOption('食費');
        await results().first().getByRole('button').click();
        await dialog().getByRole('button', { name: 'この明細のみ', exact: true }).click();
        await dialog().locator('select').selectOption('日用品');
        await dialog().getByRole('button', { name: 'カテゴリ設定を保存' }).click();
        await dialog().waitFor({ state: 'hidden' });
        await shown(search(), '該当する支出はありません');
        await search().getByLabel('カテゴリ', { exact: true }).selectOption('');
        await shown(results(), '日用品');
        await search().getByLabel('終了日').fill('2024-02-29');
        await results().first().getByRole('button').click();
        await dialog().locator('input[type="date"]').fill('2024-03-01');
        await dialog().getByRole('button', { name: '日付を保存' }).click();
        await dialog().waitFor({ state: 'hidden' });
        await shown(search(), '該当する支出はありません');
        await search().getByLabel('終了日').fill('');
        await shown(search(), '2024/03/01');
        await results().first().getByRole('button').click();
        await dialog().getByRole('button', { name: 'この明細を削除' }).click();
        await dialog().getByRole('button', { name: 'もう一度タップで削除' }).click();
        await shown(search(), '0件 · 支出合計 ¥0');
        seen.push(`search and mutations ${prefix || 'main'}`);
    }

    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport);
        for (const prefix of ['', '/yahoo']) {
            await openSearch(prefix);
            await results().first().getByRole('button').click();
            await modalReachable();
            await page.getByRole('button', { name: 'カレンダー', exact: true }).click();
            await page.getByText(`${prefix ? '個人' : '家庭'} 架空店舗 0`, { exact: true }).filter({ visible: true }).click();
            await modalReachable();
            await page.getByRole('link', { name: 'レポート', exact: true }).click();
            await page.waitForURL(`${baseURL}${prefix || '/'}`);
            await page.getByRole('button', { name: '支出検索', exact: true }).waitFor({ state: 'hidden' });
            await page.getByText(`${prefix ? '個人' : '家庭'} 架空店舗 0`, { exact: true }).click();
            await modalReachable();
        }
        seen.push(`modal 3 origins x 2 sources ${viewport.width}x${viewport.height}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    failed = true;
    await page.goto(`${baseURL}/statistics`);
    await page.getByRole('alert').filter({ hasText: 'データの取得に失敗しました' }).waitFor();
    check((await page.getByLabel('期間の収支').innerText()).includes('10,000'), 'fetch failure preserves cached totals');
    failed = false;
    await page.getByRole('button', { name: '再取得' }).click();
    await page.getByRole('alert').filter({ hasText: 'データの取得に失敗しました' }).waitFor({ state: 'hidden' });
    await page.evaluate(() => localStorage.clear());
    failed = true;
    await page.goto(`${baseURL}/calendar`);
    await page.getByRole('button', { name: '支出検索', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'データの取得に失敗しました' }).waitFor();
    check(await search().getByText('該当する支出はありません').count() === 0, 'failure differs from empty results');
    failed = false;
    pause = true;
    await page.reload();
    await page.getByRole('button', { name: '支出検索', exact: true }).click();
    await shown(search(), '読み込み中…');
    pause = false;
    resume();
    await results().first().waitFor();
    data.main = [];
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: '支出検索', exact: true }).click();
    await shown(search(), '該当する支出はありません');
    seen.push('loading / empty / failure / cache / retry');
    await page.context().clearCookies();
    await page.goto(`${baseURL}/statistics`);
    check(new URL(page.url()).pathname === '/login', 'statistics authentication protection');
    check(runtimeErrors.length === 0, `browser runtime errors: ${runtimeErrors.join(', ')}`);
    return { passed: seen, posts: posts.length };
}
