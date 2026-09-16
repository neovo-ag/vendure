import { QueryClient } from '@tanstack/react-query';
import { parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { detailPageRouteLoader } from './detail-page-route-loader.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../document-introspection/add-custom-fields.js', () => ({
    addCustomFields: (document: unknown) => document,
}));
vi.mock('@/vdb/framework/document-extension/extend-detail-form-query.js', () => ({
    extendDetailFormQuery: (document: unknown) => ({ extendedQuery: document }),
}));
vi.mock('../document-introspection/get-document-structure.js', () => ({
    getQueryName: () => 'product',
    getQueryTypeFieldInfo: () => ({ type: 'Product' }),
}));
vi.mock('./use-detail-page.js', () => ({
    getDetailQueryOptions: (_document: unknown, variables: { id: string }) => ({
        queryKey: ['DetailPage', 'product', variables],
        queryFn: query,
    }),
}));

describe('detailPageRouteLoader channel invalidation', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const key = ['DetailPage', 'product', { id: '1' }];
    const product = { id: '1', name: 'Team product' };
    const breadcrumb = vi.fn(() => []);
    const loader = detailPageRouteLoader({
        queryDocument: parse('query Product($id: ID!) { product(id: $id) { id name } }'),
        breadcrumb,
    });
    const load = () =>
        (loader as any)({
            context: { queryClient: client },
            params: { id: '1' },
            location: {},
        });

    afterEach(() => {
        client.clear();
        vi.clearAllMocks();
    });

    it('refetches a cached missing product after changing to its channel', async () => {
        client.setQueryData(key, { product: null });
        await client.invalidateQueries();
        query.mockResolvedValue({ product });
        await expect(load()).resolves.toEqual({ breadcrumb: [] });
        expect(query).toHaveBeenCalledTimes(1);
        expect(breadcrumb).toHaveBeenCalledWith(false, product, {});
    });

    it('does not reuse an invalidated product from another channel', async () => {
        client.setQueryData(key, { product });
        await client.invalidateQueries();
        query.mockResolvedValue({ product: null });
        await expect(load()).rejects.toThrow('Product with the ID 1 was not found');
        expect(query).toHaveBeenCalledTimes(1);
        expect(breadcrumb).not.toHaveBeenCalled();
    });

    it('retains fresh cached detail data', async () => {
        client.setQueryData(key, { product });
        await expect(load()).resolves.toEqual({ breadcrumb: [] });
        expect(query).not.toHaveBeenCalled();
    });
});
