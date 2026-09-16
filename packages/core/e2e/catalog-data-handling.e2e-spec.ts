import { LanguageCode } from '@vendure/common/lib/generated-types';
import { ID } from '@vendure/common/lib/shared-types';
import {
    Channel,
    ChannelService,
    Collection,
    CollectionService,
    CollectionTranslation,
    ConfigService,
    DefaultEntityAccessControlStrategy,
    DefaultSearchPlugin,
    EventBus,
    Facet,
    FacetTranslation,
    FacetValue,
    FacetValueService,
    FacetValueTranslation,
    mergeConfig,
    Product,
    ProductTranslation,
    ProductVariant,
    ProductVariantPrice,
    ProductVariantService,
    ProductVariantTranslation,
    RequestContext,
    RequestContextService,
    SearchEvent,
    TaxCategory,
    TransactionalConnection,
    VendureEntity,
} from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN } from '@vendure/testing';
import gql from 'graphql-tag';
import { createRequire } from 'node:module';
import { SelectQueryBuilder } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { initialData } from '../../../e2e-common/e2e-initial-data';
import { TEST_SETUP_TIMEOUT_MS, testConfig } from '../../../e2e-common/test-config';

const { FacetEntityResolver } = createRequire(__filename)(
    '../dist/api/resolvers/entity/facet-entity.resolver',
) as typeof import('../dist/api/resolvers/entity/facet-entity.resolver');
const { ProductVariantEntityResolver } = createRequire(__filename)(
    '../dist/api/resolvers/entity/product-variant-entity.resolver',
) as typeof import('../dist/api/resolvers/entity/product-variant-entity.resolver');
const { FulltextSearchService } = createRequire(__filename)(
    '../dist/plugin/default-search-plugin/fulltext-search.service',
) as typeof import('../dist/plugin/default-search-plugin/fulltext-search.service');
const { SearchIndexItem } = createRequire(__filename)(
    '../dist/plugin/default-search-plugin/entities/search-index-item.entity',
) as typeof import('../dist/plugin/default-search-plugin/entities/search-index-item.entity');
const { ProductEntityResolver } = createRequire(__filename)(
    '../dist/api/resolvers/entity/product-entity.resolver',
) as typeof import('../dist/api/resolvers/entity/product-entity.resolver');
const { TranslatorService } = createRequire(__filename)(
    '../dist/service/helpers/translator/translator.service',
) as typeof import('../dist/service/helpers/translator/translator.service');

class FacetTestAccessControl extends DefaultEntityAccessControlStrategy {
    deniedVariantIds: ID[] = [];
    applyAccessControl(qb: SelectQueryBuilder<VendureEntity>, entityType: typeof VendureEntity) {
        if (entityType === ProductVariant && this.deniedVariantIds.length) {
            qb.andWhere(`${qb.alias}.id NOT IN (:...deniedVariantIds)`, {
                deniedVariantIds: this.deniedVariantIds,
            });
        }
    }
}
const accessControl = new FacetTestAccessControl();

// Explicit relational fixtures also represent a search index that has not yet caught up with visibility changes.
describe('Catalog data handling', () => {
    const { server, adminClient, shopClient } = createTestEnvironment(
        mergeConfig(testConfig(), {
            apiOptions: { shopListQueryLimit: 3, adminListQueryLimit: 7 },
            authOptions: { entityAccessControlStrategy: accessControl },
            plugins: [DefaultSearchPlugin.init({})],
        }),
    );
    let connection: TransactionalConnection;
    let a: Channel;
    let b: Channel;
    let admin: RequestContext;
    let shop: RequestContext;
    let publicFacet: Facet;
    let secondFacet: Facet;
    let privateFacet: Facet;
    let values: Record<string, FacetValue>;
    let products: Product[];
    let variants: ProductVariant[];
    let collections: Record<string, Collection>;
    let search: InstanceType<typeof FulltextSearchService>;
    const encoded = (id: ID) => server.app.get(ConfigService).entityOptions.entityIdStrategy!.encodeId(id);
    const codes = (items: Array<{ code: string }>) => items.map(v => v.code).sort();
    const context = (apiType: 'shop' | 'admin', channel = a, languageCode = LanguageCode.en) =>
        new RequestContext({
            apiType,
            channel,
            languageCode,
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
        });

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        connection = server.app.get(TransactionalConnection);
        admin = await server.app
            .get(RequestContextService)
            .create({ apiType: 'admin', channelOrToken: E2E_DEFAULT_CHANNEL_TOKEN });
        a = admin.channel;
        const created = await server.app.get(ChannelService).create(admin, {
            code: 'data-b',
            token: 'data-b',
            defaultLanguageCode: LanguageCode.en,
            currencyCode: a.defaultCurrencyCode,
            pricesIncludeTax: a.pricesIncludeTax,
            defaultTaxZoneId: a.defaultTaxZone?.id,
            defaultShippingZoneId: a.defaultShippingZone?.id,
        });
        if (!('id' in created)) throw new Error('Channel fixture failed');
        b = created;
        shop = context('shop');
        search = server.app.get(FulltextSearchService);
        async function facet(code: string, isPrivate = false) {
            const f = await connection.rawConnection
                .getRepository(Facet)
                .save(new Facet({ code, isPrivate, channels: [a, b] }));
            await connection.rawConnection
                .getRepository(FacetTranslation)
                .save(
                    connection.rawConnection
                        .getRepository(FacetTranslation)
                        .create({ base: f, languageCode: LanguageCode.en, name: code }),
                );
            return f;
        }
        publicFacet = await facet('data-public');
        secondFacet = await facet('data-second');
        privateFacet = await facet('data-private', true);
        values = {};
        for (const [code, parent, channels] of [
            ['a', publicFacet, [a]],
            ['b', publicFacet, [b]],
            ['both', publicFacet, [a, b]],
            ['neither', publicFacet, []],
            ['second', secondFacet, [a, b]],
            ['private', privateFacet, [a, b]],
        ] as Array<[string, Facet, Channel[]]>) {
            const v = await connection.rawConnection
                .getRepository(FacetValue)
                .save(new FacetValue({ code, facet: parent, channels }));
            await connection.rawConnection
                .getRepository(FacetValueTranslation)
                .save([
                    new FacetValueTranslation({ base: v, languageCode: LanguageCode.en, name: `en-${code}` }),
                    new FacetValueTranslation({ base: v, languageCode: LanguageCode.de, name: `de-${code}` }),
                ]);
            values[code] = v;
        }
        products = [];
        for (let i = 0; i < 8; i++) {
            const p = await connection.rawConnection
                .getRepository(Product)
                .save(new Product({ enabled: true, channels: [a, b] }));
            await connection.rawConnection.getRepository(ProductTranslation).save(
                new ProductTranslation({
                    base: p,
                    languageCode: LanguageCode.en,
                    name: `data-${i}`,
                    slug: `data-${i}`,
                    description: '',
                }),
            );
            products.push(p);
        }
        variants = [];
        const taxCategory = await connection.rawConnection
            .getRepository(TaxCategory)
            .findOneByOrFail({ name: 'Standard Tax' });
        for (let i = 0; i < 51; i++) {
            const v = await connection.rawConnection.getRepository(ProductVariant).save(
                new ProductVariant({
                    taxCategory,
                    sku: `data-${i}`,
                    product: products[i % products.length],
                    channels: [a, b],
                    facetValues:
                        i === 50 ? [] : [values.a, values.b, values.both, values.neither, values.private],
                }),
            );
            await connection.rawConnection.getRepository(ProductVariantTranslation).save(
                new ProductVariantTranslation({
                    base: v,
                    languageCode: LanguageCode.en,
                    name: `variant-${i}`,
                }),
            );
            await connection.rawConnection.getRepository(ProductVariantPrice).save(
                new ProductVariantPrice({
                    variant: v,
                    channelId: a.id,
                    currencyCode: a.defaultCurrencyCode,
                    price: 100,
                }),
            );
            variants.push(v);
        }
        collections = {};
        for (const [code, channels, isPrivate] of [
            ['a', [a], false],
            ['b', [b], false],
            ['both', [a, b], false],
            ['neither', [], false],
            ['private', [a, b], true],
        ] as Array<[string, Channel[], boolean]>) {
            const c = await connection.rawConnection.getRepository(Collection).save(
                new Collection({
                    position: 0,
                    filters: [],
                    inheritFilters: false,
                    channels,
                    isPrivate,
                    productVariants: [variants[0], variants[8]],
                }),
            );
            await connection.rawConnection.getRepository(CollectionTranslation).save(
                new CollectionTranslation({
                    base: c,
                    languageCode: LanguageCode.en,
                    name: code,
                    slug: code,
                    description: '',
                }),
            );
            collections[code] = c;
        }
        // The index deliberately contains private/out-of-channel IDs and one unrelated parent facet ID.
        for (let i = 0; i < 8; i++) {
            const selected =
                i === 0
                    ? [values.a, values.b, values.both, values.neither, values.private]
                    : i === 1
                      ? [values.second]
                      : [];
            await connection.rawConnection.getRepository(SearchIndexItem).save(
                new SearchIndexItem({
                    productVariantId: variants[i].id,
                    productId: products[i].id,
                    channelId: a.id,
                    languageCode: LanguageCode.en,
                    enabled: true,
                    productName: `data-${i}`,
                    productVariantName: `variant-${i}`,
                    description: '',
                    slug: `data-${i}`,
                    sku: `data-${i}`,
                    price: 100,
                    priceWithTax: 100,
                    facetIds:
                        i === 0
                            ? [publicFacet.id, secondFacet.id, privateFacet.id].map(String)
                            : i === 1
                              ? [String(secondFacet.id)]
                              : [],
                    facetValueIds: selected.map(v => String(v.id)),
                    collectionIds: [],
                    collectionSlugs: [],
                    channelIds: [String(a.id)],
                    productPreview: '',
                    productVariantPreview: '',
                    productAssetId: null,
                    productVariantAssetId: null,
                }),
            );
        }
    }, TEST_SETUP_TIMEOUT_MS);
    afterAll(async () => {
        vi.restoreAllMocks();
        await server.destroy();
    });

    it('F1: removes private and foreign associations per item without altering matches', async () => {
        const result = await search.search(shop, { take: 3 });
        expect(Number(result.totalItems)).toBe(8);
        expect(result.items[0].facetValueIds.map(String).sort()).toEqual(
            [values.a.id, values.both.id].map(String).sort(),
        );
        expect(result.items[0].facetIds.map(String)).toEqual([String(publicFacet.id)]);
        expect(result.items[1].facetValueIds.map(String)).toEqual([String(values.second.id)]);
        expect(result.items[1].facetIds.map(String)).toEqual([String(secondFacet.id)]);
        expect(result.items[2].facetValueIds).toEqual([]);
        expect(result.items[2].facetIds).toEqual([]);
        const original = await search.search(admin, { take: 3 });
        expect(original.items[0].facetValueIds.map(String)).toContain(String(values.private.id));
    });

    it('F1: SQL excludes hidden values before translation; Shop API omits private aggregation', async () => {
        const spy = vi.spyOn(server.app.get(TranslatorService), 'translate');
        try {
            const result = await shopClient.query(gql`
                {
                    search(input: { take: 1 }) {
                        items {
                            facetIds
                            facetValueIds
                        }
                        facetValues {
                            facetValue {
                                code
                            }
                            count
                        }
                    }
                }
            `);
            expect(
                codes(result.search.facetValues.map((r: { facetValue: FacetValue }) => r.facetValue)),
            ).toEqual(['a', 'both', 'second']);
            const translated = spy.mock.calls
                .map(call => call[0])
                .filter(entity => entity instanceof FacetValue);
            expect(
                translated.some(
                    entity => entity.code === 'private' || entity.code === 'b' || entity.code === 'neither',
                ),
            ).toBe(false);
        } finally {
            spy.mockRestore();
        }
        expect(codes((await search.facetValues(admin, {})).map(r => r.facetValue))).toContain('private');
    });

    it('F1: visibility changes apply without reindex; known hidden filters retain matching semantics', async () => {
        const repo = connection.rawConnection.getRepository(Facet);
        await repo.update(publicFacet.id, { isPrivate: true });
        try {
            const result = await search.search(context('shop'), {
                take: 1,
                facetValueFilters: [{ and: String(values.a.id) }],
            });
            expect(Number(result.totalItems)).toBe(1);
            expect(result.items[0].facetValueIds).toEqual([]);
        } finally {
            await repo.update(publicFacet.id, { isPrivate: false });
        }
        expect(
            Number(
                (await search.search(context('shop'), { facetValueFilters: [{ and: String(values.b.id) }] }))
                    .totalItems,
            ),
        ).toBe(1);
    });

    it('F1: handles duplicate and empty indexed arrays', async () => {
        const repo = connection.rawConnection.getRepository(SearchIndexItem);
        const row = await repo.findOneByOrFail({ productVariantId: variants[0].id });
        await repo.update(
            { productVariantId: variants[0].id },
            {
                facetValueIds: [String(values.a.id), String(values.a.id)],
                facetIds: [String(publicFacet.id), String(publicFacet.id)],
            },
        );
        try {
            const result = await search.search(context('shop'), { take: 1 });
            expect(result.items[0].facetValueIds).toEqual([String(values.a.id)]);
            expect(result.items[0].facetIds).toEqual([String(publicFacet.id)]);
        } finally {
            await repo.save(row);
        }
    });

    it.each(['shop', 'admin'] as const)(
        'F2: %s nested values enforce child membership via API',
        async apiType => {
            const client = apiType === 'shop' ? shopClient : adminClient;
            const result = await client.query(
                gql`
                    query ($id: ID!) {
                        facet(id: $id) {
                            values {
                                code
                            }
                        }
                    }
                `,
                { id: encoded(publicFacet.id) },
            );
            expect(codes(result.facet.values)).toEqual(['a', 'both']);
        },
    );

    it('F2: fallback, empty preloads, language and batched parents', async () => {
        const resolver = server.app.get(FacetEntityResolver);
        const spy = vi.spyOn(connection.rawConnection.logger, 'logQuery');
        try {
            const ctx = context('shop', a, LanguageCode.de);
            const results = await Promise.all(
                [publicFacet, secondFacet].map(f =>
                    resolver.values(ctx, new Facet({ id: f.id, values: [] })),
                ),
            );
            expect(codes(results[0])).toEqual(['a', 'both']);
            expect(results[0].every(v => v.name.startsWith('de-'))).toBe(true);
            expect(codes(results[1])).toEqual(['second']);
            expect(
                spy.mock.calls.filter(([sql]) => /FROM ["`]?facet_value["`]? /i.test(sql)).length,
            ).toBeLessThanOrEqual(1);
            expect(
                codes(await resolver.values(context('shop', b), new Facet({ id: publicFacet.id }))),
            ).toEqual(['b', 'both']);
        } finally {
            spy.mockRestore();
        }
    });

    it.each(['shop', 'admin'] as const)(
        'F3: %s collections respect channel, privacy and deduplication',
        async apiType => {
            const result = await server.app
                .get(CollectionService)
                .getCollectionsByProductId(context(apiType), products[0].id, apiType === 'shop');
            const expected =
                apiType === 'shop'
                    ? [collections.a, collections.both]
                    : [collections.a, collections.both, collections.private];
            expect(result.map(c => String(c.id))).toEqual(expected.map(c => String(c.id)));
            expect(result.map(c => c.name)).toEqual(
                apiType === 'shop' ? ['a', 'both'] : ['a', 'both', 'private'],
            );
        },
    );

    it('F3: Shop product API enforces collection membership', async () => {
        const result = await shopClient.query(
            gql`
                query ($id: ID!) {
                    product(id: $id) {
                        collections {
                            id
                        }
                    }
                }
            `,
            { id: encoded(products[0].id) },
        );
        expect(result.product.collections.map((c: { id: string }) => c.id)).toEqual(
            [collections.a, collections.both].map(c => encoded(c.id)),
        );
    });

    it.each([undefined, 0, 1, 3])('F4: valid Shop take %s preserves count and input', async take => {
        const input = Object.freeze(take === undefined ? {} : { take });
        const spy = vi.spyOn(search.searchStrategy, 'getSearchResults');
        try {
            const result = await search.search(shop, input);
            expect(result.items).toHaveLength(take ?? 3);
            expect(Number(result.totalItems)).toBe(8);
            if (take === 0) expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    it.each([
        { take: 4 },
        { take: -1 },
        { skip: -1 },
        { take: 1.5 },
        { skip: 1.5 },
        { take: Number.MAX_SAFE_INTEGER + 1 },
        { skip: Infinity },
    ])('F4: rejects invalid direct service pagination %j before querying', async input => {
        const items = vi.spyOn(search.searchStrategy, 'getSearchResults');
        const count = vi.spyOn(search.searchStrategy, 'getTotalCount');
        try {
            await expect(search.search(shop, input)).rejects.toThrow();
            expect(items).not.toHaveBeenCalled();
            expect(count).not.toHaveBeenCalled();
        } finally {
            items.mockRestore();
            count.mockRestore();
        }
    });

    it('F4: independent Admin limit and public GraphQL boundary', async () => {
        expect((await search.search(admin, { take: 7 })).items).toHaveLength(7);
        await expect(search.search(admin, { take: 8 })).rejects.toThrow();
        await expect(
            shopClient.query(gql`
                {
                    search(input: { take: 4 }) {
                        totalItems
                    }
                }
            `),
        ).rejects.toThrow();
        const zero = await shopClient.query(gql`
            {
                search(input: { take: 0 }) {
                    items {
                        productId
                    }
                    totalItems
                    facetValues {
                        count
                    }
                }
            }
        `);
        expect(zero.search.items).toEqual([]);
        expect(zero.search.totalItems).toBe(8);
        expect(zero.search.facetValues.length).toBeGreaterThan(0);
    });

    it.each([1, 49, 50, 51])(
        'F5: %s variant facet reads grow by batches without variant reloads',
        async size => {
            const resolver = server.app.get(ProductVariantEntityResolver);
            const reload = vi.spyOn(server.app.get(ProductVariantService), 'getFacetValuesForVariant');
            const queries = vi.spyOn(connection.rawConnection.logger, 'logQuery');
            try {
                const ctx = context('shop');
                const result = await Promise.all(
                    variants
                        .slice(0, size)
                        .map(v => resolver.facetValues(ctx, new ProductVariant({ id: v.id }), 'shop')),
                );
                expect(codes(result[0])).toEqual(['a', 'both']);
                if (size === 51) expect(result[50]).toEqual([]);
                console.log(
                    'facet-batch',
                    JSON.stringify({
                        size,
                        reloads: reload.mock.calls.length,
                        facetQueries: queries.mock.calls.filter(([q]) =>
                            /FROM ["`]?facet_value["`]? /i.test(q),
                        ).length,
                    }),
                );
                expect(reload).not.toHaveBeenCalled();
                const sql = queries.mock.calls.map(([q]) => q);
                expect(sql.filter(q => /FROM ["`]?facet_value["`]? /i.test(q)).length).toBeLessThanOrEqual(
                    Math.ceil(size / 50),
                );
                expect(sql.some(q => /product_variant_price/.test(q))).toBe(false);
            } finally {
                reload.mockRestore();
                queries.mockRestore();
            }
        },
    );

    it('F5: duplicate/missing keys, empty preloads and differing visibility contexts', async () => {
        const resolver = server.app.get(ProductVariantEntityResolver);
        const ctx = context('shop', b, LanguageCode.de);
        const parents = [
            new ProductVariant({ id: variants[0].id, facetValues: [] }),
            new ProductVariant({ id: variants[0].id }),
            new ProductVariant({ id: 999999 }),
        ];
        const result = await Promise.all(parents.map(v => resolver.facetValues(ctx, v, 'shop')));
        expect(codes(result[0])).toEqual(['b', 'both']);
        expect(result[1]).toEqual(result[0]);
        expect(result[2]).toEqual([]);
        expect(result[0].every(v => v.name.startsWith('de-'))).toBe(true);
        expect(codes(await resolver.facetValues(context('admin'), variants[0], 'admin'))).toEqual([
            'a',
            'both',
            'private',
        ]);
    });

    it('F1: ID projection batches 501 keys, avoids hydration, and short-circuits empty input', async () => {
        const service = server.app.get(FacetValueService);
        const query = vi.spyOn(connection.rawConnection.logger, 'logQuery');
        const translate = vi.spyOn(server.app.get(TranslatorService), 'translate');
        try {
            expect(await service.getPublicValueIds(shop, [])).toEqual([]);
            expect(await service.findPublicByIds(shop, [])).toEqual([]);
            expect(query).not.toHaveBeenCalled();
            const ids = [values.a.id, ...Array.from({ length: 500 }, (_, i) => 100000 + i), values.a.id];
            expect(await service.getPublicValueIds(shop, ids)).toEqual([
                { id: values.a.id, facetId: publicFacet.id },
            ]);
            expect(query.mock.calls).toHaveLength(2);
            expect(translate).not.toHaveBeenCalled();
            expect(query.mock.calls.every(([sql]) => !sql.includes('translation'))).toBe(true);
            expect(query.mock.calls.every(([, parameters]) => (parameters?.length ?? 0) <= 502)).toBe(true);
        } finally {
            query.mockRestore();
            translate.mockRestore();
        }
    });

    it('F2/F5: sequential reads see writes; transaction reads roll back without leaking', async () => {
        const service = server.app.get(FacetValueService);
        const ctx = context('shop');
        expect(codes(await service.getValuesForOwner(ctx, 'variant', variants[0].id))).toEqual(['a', 'both']);
        await expect(
            connection.withTransaction(ctx, async tx => {
                await connection.getRepository(tx, Facet).update(publicFacet.id, { isPrivate: true });
                expect(await service.getValuesForOwner(tx, 'variant', variants[0].id)).toEqual([]);
                expect(await service.getValuesForOwner(tx, 'facet', publicFacet.id)).toEqual([]);
                throw new Error('intentional rollback');
            }),
        ).rejects.toThrow('intentional rollback');
        expect(codes(await service.getValuesForOwner(context('shop'), 'variant', variants[0].id))).toEqual([
            'a',
            'both',
        ]);
    });

    it('F4: zero publishes the search event without querying items; sibling entry points validate', async () => {
        const event = vi.spyOn(server.app.get(EventBus), 'publish');
        const facets = vi.spyOn(search.searchStrategy, 'getFacetValueIds');
        const collections = vi.spyOn(search.searchStrategy, 'getCollectionIds');
        try {
            const input = Object.freeze({ take: 0, skip: 0 });
            await search.search(context('shop'), input);
            expect(event.mock.calls.some(([e]) => e instanceof SearchEvent && e.input === input)).toBe(true);
            await expect(search.facetValues(shop, { take: -1 })).rejects.toThrow();
            await expect(search.collections(shop, { skip: -1 })).rejects.toThrow();
            expect(facets).not.toHaveBeenCalled();
            expect(collections).not.toHaveBeenCalled();
        } finally {
            event.mockRestore();
            facets.mockRestore();
            collections.mockRestore();
        }
    });

    it('F6: product facet loading ignores partial/empty preloads and batches authoritative associations', async () => {
        const relation = connection.rawConnection
            .getRepository(Product)
            .createQueryBuilder()
            .relation(Product, 'facetValues');
        await relation.of(products[0].id).add([values.a.id, values.b.id, values.private.id]);
        try {
            const resolver = server.app.get(ProductEntityResolver);
            const result = await resolver.facetValues(
                context('shop'),
                new Product({ id: products[0].id, facetValues: [] }),
                'shop',
            );
            expect(codes(result)).toEqual(['a']);
            const api = await shopClient.query(
                gql`
                    query ($id: ID!) {
                        product(id: $id) {
                            facetValues {
                                code
                            }
                        }
                    }
                `,
                { id: encoded(products[0].id) },
            );
            expect(codes(api.product.facetValues)).toEqual(['a']);
        } finally {
            await relation.of(products[0].id).remove([values.a.id, values.b.id, values.private.id]);
        }
    });

    it('F7: collection and variant-to-product paths do not hydrate discarded private facets', async () => {
        const relation = connection.rawConnection
            .getRepository(Product)
            .createQueryBuilder()
            .relation(Product, 'facetValues');
        await relation.of(products[0].id).add([values.a.id, values.private.id]);
        const spy = vi.spyOn(server.app.get(TranslatorService), 'translate');
        try {
            await shopClient.query(
                gql`
                    query ($id: ID!) {
                        collection(id: $id) {
                            productVariants(options: { take: 2 }) {
                                items {
                                    facetValues {
                                        code
                                    }
                                    product {
                                        facetValues {
                                            code
                                        }
                                    }
                                }
                            }
                        }
                    }
                `,
                { id: encoded(collections.a.id) },
            );
            const preloaded = spy.mock.calls.flatMap(([entity]) =>
                entity instanceof Product || entity instanceof ProductVariant
                    ? (entity.facetValues ?? [])
                    : [],
            );
            expect(preloaded.some(v => v.code === 'private' || v.code === 'b')).toBe(false);
        } finally {
            spy.mockRestore();
            await relation.of(products[0].id).remove([values.a.id, values.private.id]);
        }
    });

    it('F8: a joined variant parent cannot bypass variant-specific row access control', async () => {
        accessControl.deniedVariantIds = [variants[0].id];
        try {
            const resolver = server.app.get(ProductVariantEntityResolver);
            expect(
                await resolver.facetValues(
                    context('shop'),
                    new ProductVariant({ id: variants[0].id }),
                    'shop',
                ),
            ).toEqual([]);
        } finally {
            accessControl.deniedVariantIds = [];
        }
    });

    it('F2: nonempty preloads cannot grant foreign children; many parent fields stay batched', async () => {
        const resolver = server.app.get(FacetEntityResolver);
        const ctx = context('shop');
        const queries = vi.spyOn(connection.rawConnection.logger, 'logQuery');
        try {
            const loaded = new Facet({ id: publicFacet.id, values: [values.b, values.neither] });
            const result = await Promise.all(
                [loaded, new Facet({ id: secondFacet.id }), loaded].map(parent =>
                    resolver.values(ctx, parent),
                ),
            );
            expect(codes(result[0])).toEqual(['a', 'both']);
            expect(codes(result[1])).toEqual(['second']);
            expect(result[2]).toEqual(result[0]);
            expect(
                queries.mock.calls.filter(([sql]) => /FROM ["`]?facet_value["`]? /i.test(sql)),
            ).toHaveLength(1);
        } finally {
            queries.mockRestore();
        }
    });

    it('F4: omitted default remains 25 when limits permit; zero limit and null pagination are bounded', async () => {
        const api = server.app.get(ConfigService).apiOptions;
        const original = api.shopListQueryLimit;
        const spy = vi.spyOn(search.searchStrategy, 'getSearchResults');
        try {
            api.shopListQueryLimit = 100;
            await shopClient.query(gql`
                {
                    search(input: { take: null, skip: null }) {
                        totalItems
                    }
                }
            `);
            expect(spy.mock.calls[0][1]).toMatchObject({ take: 25, skip: 0 });
            api.shopListQueryLimit = 0;
            spy.mockClear();
            expect((await search.search(context('shop'), {})).items).toEqual([]);
            expect(spy).not.toHaveBeenCalled();
        } finally {
            api.shopListQueryLimit = original;
            spy.mockRestore();
        }
    });

    it('F4: a valid skip selects the next item without changing the total', async () => {
        const result = await search.search(context('shop'), { take: 1, skip: 1 });
        expect(String(result.items[0].productVariantId)).toBe(String(variants[1].id));
        expect(Number(result.totalItems)).toBe(8);
    });
});
