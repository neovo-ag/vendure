import { Injectable } from '@nestjs/common';
import {
    CreateFacetValueInput,
    CreateFacetValueWithFacetInput,
    DeletionResponse,
    DeletionResult,
    LanguageCode,
    UpdateFacetValueInput,
} from '@vendure/common/lib/generated-types';
import { ID, PaginatedList } from '@vendure/common/lib/shared-types';
import DataLoader from 'dataloader';

import { RequestContext } from '../../api/common/request-context';
import { RelationPaths } from '../../api/decorators/relations.decorator';
import { RequestContextCacheService } from '../../cache/request-context-cache.service';
import { Instrument } from '../../common/instrument-decorator';
import { ListQueryOptions } from '../../common/types/common-types';
import { Translated } from '../../common/types/locale-types';
import { assertFound } from '../../common/utils';
import { ConfigService } from '../../config/config.service';
import { TransactionalConnection } from '../../connection/transactional-connection';
import { Product, ProductVariant } from '../../entity';
import { FacetValueTranslation } from '../../entity/facet-value/facet-value-translation.entity';
import { FacetValue } from '../../entity/facet-value/facet-value.entity';
import { Facet } from '../../entity/facet/facet.entity';
import { EventBus } from '../../event-bus';
import { FacetValueEvent } from '../../event-bus/events/facet-value-event';
import { CustomFieldRelationService } from '../helpers/custom-field-relation/custom-field-relation.service';
import { ListQueryBuilder } from '../helpers/list-query-builder/list-query-builder';
import { TranslatableSaver } from '../helpers/translatable-saver/translatable-saver';
import { TranslatorService } from '../helpers/translator/translator.service';
import { translateDeep } from '../helpers/utils/translate-entity';

import { ChannelService } from './channel.service';

/**
 * @description
 * Contains methods relating to {@link FacetValue} entities.
 *
 * @docsCategory services
 */
@Injectable()
@Instrument()
export class FacetValueService {
    constructor(
        private connection: TransactionalConnection,
        private translatableSaver: TranslatableSaver,
        private configService: ConfigService,
        private customFieldRelationService: CustomFieldRelationService,
        private channelService: ChannelService,
        private eventBus: EventBus,
        private translator: TranslatorService,
        private listQueryBuilder: ListQueryBuilder,
        private requestCache: RequestContextCacheService,
    ) {}

    /**
     * @deprecated Use {@link FacetValueService.findAll findAll(ctx, lang)} instead
     */
    findAll(lang: LanguageCode): Promise<Array<Translated<FacetValue>>>;
    findAll(ctx: RequestContext, lang: LanguageCode): Promise<Array<Translated<FacetValue>>>;
    findAll(
        ctxOrLang: RequestContext | LanguageCode,
        lang?: LanguageCode,
    ): Promise<Array<Translated<FacetValue>>> {
        const [repository, languageCode, channelLanguageCode] =
            ctxOrLang instanceof RequestContext
                ? [
                      this.connection.getRepository(ctxOrLang, FacetValue),
                      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                      lang!,
                      ctxOrLang.channel.defaultLanguageCode,
                  ]
                : [this.connection.rawConnection.getRepository(FacetValue), ctxOrLang, undefined];
        const globalDefaultLanguageCode = this.configService.defaultLanguageCode;
        return repository
            .find({
                relations: ['facet'],
            })
            .then(facetValues =>
                facetValues.map(facetValue =>
                    translateDeep(
                        facetValue,
                        channelLanguageCode
                            ? [languageCode, channelLanguageCode, globalDefaultLanguageCode]
                            : [languageCode, globalDefaultLanguageCode],
                        ['facet'],
                    ),
                ),
            );
    }

    /**
     * @description
     * Returns a PaginatedList of FacetValues.
     *
     * TODO: in v2 this should replace the `findAll()` method.
     * A separate method was created just to avoid a breaking change in v1.9.
     */
    findAllList(
        ctx: RequestContext,
        options?: ListQueryOptions<FacetValue>,
        relations?: RelationPaths<FacetValue>,
    ): Promise<PaginatedList<Translated<FacetValue>>> {
        return this.listQueryBuilder
            .build(FacetValue, options, {
                ctx,
                relations: relations ?? ['facet'],
                channelId: ctx.channelId,
            })
            .getManyAndCount()
            .then(([items, totalItems]) => {
                return {
                    items: items.map(item => this.translator.translate(item, ctx, ['facet'])),
                    totalItems,
                };
            });
    }

    findOne(ctx: RequestContext, id: ID): Promise<Translated<FacetValue> | undefined> {
        return this.connection
            .getRepository(ctx, FacetValue)
            .findOne({
                where: { id },
                relations: ['facet'],
            })
            .then(
                facetValue =>
                    (facetValue && this.translator.translate(facetValue, ctx, ['facet'])) ?? undefined,
            );
    }

    findByIds(ctx: RequestContext, ids: ID[]): Promise<Array<Translated<FacetValue>>> {
        const facetValues = this.connection.findByIdsInChannel(ctx, FacetValue, ids, ctx.channelId, {
            relations: ['facet'],
        });
        return facetValues.then(values =>
            values.map(facetValue => this.translator.translate(facetValue, ctx, ['facet'])),
        );
    }

    /** @internal */
    async getPublicValueIds(ctx: RequestContext, ids: ID[]): Promise<Array<{ id: ID; facetId: ID }>> {
        const uniqueIds = [
            ...new Map(ids.filter(id => String(id).length > 0).map(id => [String(id), id])).values(),
        ];
        const loader = this.requestCache.get(
            ctx,
            'FacetValueService.publicValueIds',
            () =>
                new DataLoader<ID, { id: ID; facetId: ID } | undefined>(
                    async keys => {
                        const rows = await this.visibleValuesQuery(ctx)
                            .select('value.id', 'id')
                            .addSelect('value.facetId', 'facetId')
                            .andWhere('value.id IN (:...ids)', { ids: [...new Set(keys)] })
                            .getRawMany<{ id: ID; facetId: ID }>();
                        const byId = new Map(rows.map(row => [String(row.id), row]));
                        return keys.map(key => byId.get(String(key)));
                    },
                    { cache: false, maxBatchSize: 500 },
                ),
        );
        const values = await Promise.all(uniqueIds.map(id => loader.load(id)));
        return values.filter((value): value is { id: ID; facetId: ID } => value !== undefined);
    }

    /** @internal */
    async findPublicByIds(ctx: RequestContext, ids: ID[]): Promise<Array<Translated<FacetValue>>> {
        const result: Array<Translated<FacetValue>> = [];
        const uniqueIds = [
            ...new Map(ids.filter(id => String(id).length > 0).map(id => [String(id), id])).values(),
        ];
        for (let offset = 0; offset < uniqueIds.length; offset += 500) {
            const values = await this.visibleValuesQuery(ctx)
                .addSelect('facet')
                .leftJoinAndSelect('value.translations', 'translation')
                .leftJoinAndSelect('facet.translations', 'facetTranslation')
                .andWhere('value.id IN (:...ids)', { ids: uniqueIds.slice(offset, offset + 500) })
                .getMany();
            result.push(...values.map(value => this.translator.translate(value, ctx, ['facet'])));
        }
        return result;
    }

    private visibleValuesQuery(ctx: RequestContext) {
        return this.connection
            .getRepository(ctx, FacetValue)
            .createQueryBuilder('value')
            .innerJoin('value.facet', 'facet')
            .innerJoin('value.channels', 'valueChannel', 'valueChannel.id = :channelId', {
                channelId: ctx.channelId,
            })
            .where('facet.isPrivate = :isPrivate', { isPrivate: false });
    }

    /**
     * @internal
     * Read authoritative associations rather than trusting potentially partial preloaded relations.
     * The loader batches work but does not retain results across writes in the same request.
     */
    getValuesForOwner(
        ctx: RequestContext,
        ownerType: 'facet' | 'product' | 'variant',
        id: ID,
    ): Promise<Array<Translated<FacetValue>>> {
        const loader = this.requestCache.get(
            ctx,
            `FacetValueService.owner:${ownerType}`,
            () =>
                new DataLoader<ID, Array<Translated<FacetValue>>>(
                    async ids => {
                        let ownerIds = [...new Map(ids.map(ownerId => [String(ownerId), ownerId])).values()];
                        if (this.configService.authOptions.entityAccessControlStrategy.applyAccessControl) {
                            const ownerEntity =
                                ownerType === 'facet'
                                    ? Facet
                                    : ownerType === 'product'
                                      ? Product
                                      : ProductVariant;
                            const allowed = await this.connection
                                .getRepository<Facet | Product | ProductVariant>(ctx, ownerEntity)
                                .createQueryBuilder('facetOwner')
                                .select('facetOwner.id', 'id')
                                .where('facetOwner.id IN (:...ownerIds)', { ownerIds })
                                .getRawMany<{ id: ID }>();
                            ownerIds = allowed.map(owner => owner.id);
                            if (!ownerIds.length) {
                                return ids.map(() => []);
                            }
                        }
                        const qb = this.connection
                            .getRepository(ctx, FacetValue)
                            .createQueryBuilder('value')
                            .innerJoinAndSelect('value.facet', 'facet')
                            .leftJoinAndSelect('value.translations', 'translation')
                            .leftJoinAndSelect('facet.translations', 'facetTranslation')
                            .innerJoin('value.channels', 'valueChannel', 'valueChannel.id = :channelId', {
                                channelId: ctx.channelId,
                            });
                        const ownerAlias = ownerType === 'facet' ? 'facet' : 'owner';
                        if (ownerType !== 'facet') {
                            qb.innerJoin(
                                ownerType === 'product' ? 'value.products' : 'value.productVariants',
                                'owner',
                            );
                        }
                        qb.innerJoin(`${ownerAlias}.channels`, 'ownerChannel', 'ownerChannel.id = :channelId')
                            .andWhere(`${ownerAlias}.id IN (:...ids)`, { ids: ownerIds })
                            .orderBy('value.id', 'ASC');
                        if (ownerType !== 'facet') {
                            qb.addSelect('owner.id', 'ownerId');
                        }
                        if (ctx.apiType === 'shop') {
                            qb.andWhere('facet.isPrivate = :isPrivate', { isPrivate: false });
                        }
                        const { entities, raw } = await qb.getRawAndEntities<{
                            ownerId: ID;
                            facet_id: ID;
                            value_id: ID;
                        }>();
                        const values = new Map(
                            entities.map(value => [
                                String(value.id),
                                this.translator.translate(value, ctx, ['facet']),
                            ]),
                        );
                        const grouped = new Map<string, Map<string, Translated<FacetValue>>>();
                        for (const row of raw) {
                            const value = values.get(String(row.value_id));
                            if (value) {
                                const group =
                                    grouped.get(String(ownerType === 'facet' ? row.facet_id : row.ownerId)) ??
                                    new Map();
                                group.set(String(value.id), value);
                                grouped.set(
                                    String(ownerType === 'facet' ? row.facet_id : row.ownerId),
                                    group,
                                );
                            }
                        }
                        return ids.map(ownerId => [...(grouped.get(String(ownerId))?.values() ?? [])]);
                    },
                    { cache: false, maxBatchSize: 50 },
                ),
        );
        return loader.load(id);
    }

    /**
     * @description
     * Returns all FacetValues belonging to the Facet with the given id.
     */
    findByFacetId(ctx: RequestContext, id: ID): Promise<Array<Translated<FacetValue>>> {
        return this.getValuesForOwner(ctx, 'facet', id);
    }

    /**
     * @description
     * Returns all FacetValues belonging to the Facet with the given id.
     */
    findByFacetIdList(
        ctx: RequestContext,
        id: ID,
        options?: ListQueryOptions<FacetValue>,
        relations?: RelationPaths<FacetValue>,
    ): Promise<PaginatedList<Translated<FacetValue>>> {
        return this.listQueryBuilder
            .build(FacetValue, options, {
                ctx,
                relations: relations ?? ['facet'],
                channelId: ctx.channelId,
                entityAlias: 'facetValue',
            })
            .andWhere('facetValue.facetId = :id', { id })
            .getManyAndCount()
            .then(([items, totalItems]) => {
                return {
                    items: items.map(item => this.translator.translate(item, ctx, ['facet'])),
                    totalItems,
                };
            });
    }

    async create(
        ctx: RequestContext,
        facet: Facet,
        input: CreateFacetValueInput | CreateFacetValueWithFacetInput,
    ): Promise<Translated<FacetValue>> {
        const facetValue = await this.translatableSaver.create({
            ctx,
            input,
            entityType: FacetValue,
            translationType: FacetValueTranslation,
            beforeSave: async fv => {
                fv.facet = facet;
                await this.channelService.assignToCurrentChannel(fv, ctx);
            },
        });
        const facetValueWithRelations = await this.customFieldRelationService.updateRelations(
            ctx,
            FacetValue,
            input as CreateFacetValueInput,
            facetValue,
        );
        await this.eventBus.publish(new FacetValueEvent(ctx, facetValueWithRelations, 'created', input));
        return assertFound(this.findOne(ctx, facetValue.id));
    }

    async update(ctx: RequestContext, input: UpdateFacetValueInput): Promise<Translated<FacetValue>> {
        // Ensure the entity belongs to the active channel before updating.
        await this.connection.getEntityOrThrow(ctx, FacetValue, input.id, { channelId: ctx.channelId });
        const facetValue = await this.translatableSaver.update({
            ctx,
            input,
            entityType: FacetValue,
            translationType: FacetValueTranslation,
        });
        await this.customFieldRelationService.updateRelations(ctx, FacetValue, input, facetValue);
        await this.eventBus.publish(new FacetValueEvent(ctx, facetValue, 'updated', input));
        return assertFound(this.findOne(ctx, facetValue.id));
    }

    async delete(ctx: RequestContext, id: ID, force: boolean = false): Promise<DeletionResponse> {
        const { productCount, variantCount } = await this.checkFacetValueUsage(ctx, [id]);

        const isInUse = !!(productCount || variantCount);
        const both = !!(productCount && variantCount) ? 'both' : 'single';
        let message = '';
        let result: DeletionResult;

        const facetValue = await this.connection.getEntityOrThrow(ctx, FacetValue, id, {
            channelId: ctx.channelId,
        });
        const i18nVars = {
            products: productCount,
            variants: variantCount,
            both,
            facetValueCode: facetValue.code,
        };
        // Create a new facetValue so that the id is still available
        // after deletion (the .remove() method sets it to undefined)
        const deletedFacetValue = new FacetValue(facetValue);

        if (!isInUse) {
            await this.connection.getRepository(ctx, FacetValue).remove(facetValue);
            await this.eventBus.publish(new FacetValueEvent(ctx, deletedFacetValue, 'deleted', id));
            result = DeletionResult.DELETED;
        } else if (force) {
            await this.connection.getRepository(ctx, FacetValue).remove(facetValue);
            await this.eventBus.publish(new FacetValueEvent(ctx, deletedFacetValue, 'deleted', id));
            message = ctx.translate('message.facet-value-force-deleted', i18nVars);
            result = DeletionResult.DELETED;
        } else {
            message = ctx.translate('message.facet-value-used', i18nVars);
            result = DeletionResult.NOT_DELETED;
        }

        return {
            result,
            message,
        };
    }

    /**
     * @description
     * Checks for usage of the given FacetValues in any Products or Variants, and returns the counts.
     */
    async checkFacetValueUsage(
        ctx: RequestContext,
        facetValueIds: ID[],
        channelId?: ID,
    ): Promise<{ productCount: number; variantCount: number }> {
        const consumingProductsQb = this.connection
            .getRepository(ctx, Product)
            .createQueryBuilder('product')
            .leftJoinAndSelect('product.facetValues', 'facetValues')
            .where('facetValues.id IN (:...facetValueIds)', { facetValueIds })
            .andWhere('product.deletedAt IS NULL');

        const consumingVariantsQb = this.connection
            .getRepository(ctx, ProductVariant)
            .createQueryBuilder('variant')
            .leftJoinAndSelect('variant.facetValues', 'facetValues')
            .where('facetValues.id IN (:...facetValueIds)', { facetValueIds })
            .andWhere('variant.deletedAt IS NULL');

        if (channelId) {
            consumingProductsQb
                .leftJoin('product.channels', 'product_channel')
                .leftJoin('facetValues.channels', 'channel')
                .andWhere('product_channel.id = :channelId')
                .andWhere('channel.id = :channelId')
                .setParameter('channelId', channelId);
            consumingVariantsQb
                .leftJoin('variant.channels', 'variant_channel')
                .leftJoin('facetValues.channels', 'channel')
                .andWhere('variant_channel.id = :channelId')
                .andWhere('channel.id = :channelId')
                .setParameter('channelId', channelId);
        }

        return {
            productCount: await consumingProductsQb.getCount(),
            variantCount: await consumingVariantsQb.getCount(),
        };
    }
}
