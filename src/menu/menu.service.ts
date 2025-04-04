import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  InternalServerErrorException,
  Logger, // Import Logger
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthService } from '../auth/auth.service';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';
import {
  Prisma,
  MenuItem,
  Role,
  CustomizationGroup as PrismaCustomizationGroup,
} from '@prisma/client';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
import { UpsertCustomizationGroupDto } from './dto/upsert-customization-group.dto';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Type alias representing a CustomizationGroup fetched from the database,
 * specifically including only the IDs of its customizationOptions.
 * This minimal structure is used by the syncCustomizationGroups logic.
 */
type ExistingCustomizationGroup = PrismaCustomizationGroup & {
  customizationOptions: Array<{ id: number }>;
};

@Injectable()
export class MenuService {
  // Instantiate the logger with the service context
  private readonly logger = new Logger(MenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /**
   * Reusable Prisma Include clause for fetching menu items with full details
   * (category, customization groups, and options), ensuring consistent data structure.
   * Groups and options are ordered alphabetically by name.
   */
  private readonly menuItemInclude = {
    category: true,
    customizationGroups: {
      orderBy: { name: 'asc' },
      include: {
        customizationOptions: {
          orderBy: { name: 'asc' },
        },
      },
    },
  } satisfies Prisma.MenuItemInclude;

  /**
   * Retrieves all menu items for a specific store.
   * NOTE: Currently assumes public read access. Add auth check if needed.
   */
  async getStoreMenuItems(storeId: number): Promise<MenuItem[]> {
    this.logger.log(`Workspaceing menu items for store ID: ${storeId}`);
    return this.prisma.menuItem.findMany({
      where: { storeId },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      include: this.menuItemInclude,
    });
  }

  /**
   * Retrieves a single menu item by its ID, including details.
   * NOTE: Currently assumes public read access if the ID is known.
   */
  async getMenuItemById(itemId: number): Promise<MenuItem> {
    this.logger.log(`Workspaceing menu item by ID: ${itemId}`);
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      include: this.menuItemInclude,
    });
    if (!item) {
      this.logger.warn(`Menu item with ID ${itemId} not found.`);
      throw new NotFoundException(`Menu item with ID ${itemId} not found.`);
    }
    return item;
  }

  /**
   * Creates a new menu item within a store. Requires OWNER or ADMIN role.
   */
  async createMenuItem(
    userId: number,
    storeId: number,
    dto: CreateMenuItemDto,
  ): Promise<MenuItem> {
    this.logger.log(
      `User ${userId} attempting to create menu item in store ${storeId}`,
    );
    await this.authService.checkStorePermission(userId, storeId, [
      Role.OWNER,
      Role.ADMIN,
    ]);

    if (!dto.category || !dto.category.name) {
      throw new BadRequestException(
        'Category information (including name) is required when creating a menu item.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        this.logger.debug(
          `[Transaction] Upserting category for store ${storeId}`,
        );
        const categoryId = await this.upsertCategory(tx, dto.category, storeId);

        this.logger.debug(
          `[Transaction] Calculating sort order for category ${categoryId}`,
        );
        const maxSort = await tx.menuItem.aggregate({
          where: { storeId, categoryId },
          _max: { sortOrder: true },
        });
        const newSortOrder = (maxSort._max.sortOrder ?? -1) + 1;

        this.logger.debug(`[Transaction] Creating menu item "${dto.name}"`);
        const menuItem = await tx.menuItem.create({
          data: {
            storeId,
            categoryId,
            name: dto.name,
            description: dto.description,
            basePrice: dto.basePrice,
            imageKey: dto.imageKey,
            sortOrder: newSortOrder,
          },
          select: { id: true },
        });
        this.logger.log(`Created menu item with ID: ${menuItem.id}`);

        if (dto.customizationGroups?.length) {
          this.logger.debug(
            `[Transaction] Creating customizations for item ${menuItem.id}`,
          );
          await this.createCustomizations(
            tx,
            menuItem.id,
            dto.customizationGroups,
          );
        }

        this.logger.debug(
          `[Transaction] Fetching created item ${menuItem.id} with includes`,
        );
        return tx.menuItem.findUniqueOrThrow({
          where: { id: menuItem.id },
          include: this.menuItemInclude,
        });
      });
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        this.logger.warn(
          `Validation/Permission error creating menu item for store ${storeId}: ${error.message}`,
        );
        throw error;
      }
      this.logger.error(
        `Unexpected error creating menu item for store ${storeId}`,
        error,
      );
      throw new InternalServerErrorException('Failed to create menu item.');
    }
  }

  /**
   * Updates an existing menu item. Requires OWNER or ADMIN role.
   */
  async updateMenuItem(
    userId: number,
    storeId: number,
    itemId: number,
    dto: UpdateMenuItemDto,
  ): Promise<MenuItem> {
    this.logger.log(
      `User ${userId} attempting to update menu item ${itemId} in store ${storeId}`,
    );
    await this.authService.checkStorePermission(userId, storeId, [
      Role.OWNER,
      Role.ADMIN,
    ]);

    try {
      return await this.prisma.$transaction(async (tx) => {
        this.logger.debug(
          `[Transaction] Fetching existing menu item ${itemId}`,
        );
        const existingMenuItem = await tx.menuItem.findUnique({
          where: { id: itemId },
          include: this.menuItemInclude,
        });

        if (!existingMenuItem) {
          this.logger.warn(
            `[Transaction] Update failed: Menu item ${itemId} not found.`,
          );
          throw new NotFoundException(`Menu item with ID ${itemId} not found.`);
        }
        if (existingMenuItem.storeId !== storeId) {
          this.logger.warn(
            `[Transaction] Forbidden: Item ${itemId} does not belong to store ${storeId}.`,
          );
          throw new ForbiddenException(
            `Menu item (ID: ${itemId}) does not belong to the specified store (ID: ${storeId}).`,
          );
        }

        let newCategoryId = existingMenuItem.categoryId;
        if (dto.category) {
          this.logger.debug(
            `[Transaction] Upserting category for update of item ${itemId}`,
          );
          if (!dto.category.name) {
            throw new BadRequestException(
              'Category name is required when updating category information.',
            );
          }
          newCategoryId = await this.upsertCategory(tx, dto.category, storeId);
        }

        this.logger.debug(
          `[Transaction] Updating menu item ${itemId} basic fields`,
        );
        await tx.menuItem.update({
          where: { id: itemId },
          data: {
            name: dto.name,
            description: dto.description,
            basePrice: dto.basePrice,
            imageKey: dto.imageKey,
            categoryId:
              newCategoryId !== existingMenuItem.categoryId
                ? newCategoryId
                : undefined,
          },
        });

        if (dto.customizationGroups !== undefined) {
          this.logger.debug(
            `[Transaction] Syncing customizations for item ${itemId}`,
          );
          const existingGroups =
            existingMenuItem.customizationGroups as unknown as ExistingCustomizationGroup[];
          await this.syncCustomizationGroups(
            tx,
            itemId,
            existingGroups,
            dto.customizationGroups,
          );
        }

        this.logger.debug(
          `[Transaction] Fetching updated item ${itemId} with includes`,
        );
        return tx.menuItem.findUniqueOrThrow({
          where: { id: itemId },
          include: this.menuItemInclude,
        });
      });
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        this.logger.warn(
          `Validation/Permission error updating menu item ${itemId} for store ${storeId}: ${error.message}`,
        );
        throw error;
      }
      this.logger.error(
        `Unexpected error updating menu item ${itemId} for store ${storeId}`,
        error,
      );
      throw new InternalServerErrorException('Failed to update menu item.');
    }
  }

  /**
   * Deletes a menu item. Requires OWNER or ADMIN role (configurable).
   */
  async deleteMenuItem(
    userId: number,
    storeId: number,
    itemId: number,
  ): Promise<{ id: number }> {
    this.logger.log(
      `User ${userId} attempting to delete menu item ${itemId} from store ${storeId}`,
    );
    const requiredRoles: Role[] = [Role.OWNER, Role.ADMIN];
    await this.authService.checkStorePermission(userId, storeId, requiredRoles);

    try {
      return await this.prisma.$transaction(async (tx) => {
        this.logger.debug(
          `[Transaction] Verifying item ${itemId} for deletion`,
        );
        const item = await tx.menuItem.findUnique({
          where: { id: itemId },
          select: { storeId: true },
        });

        if (!item) {
          // Use logger.warn as this might be expected (e.g., idempotent requests)
          this.logger.warn(
            `[Transaction] Attempted to delete non-existent menu item (ID: ${itemId}). Assuming success.`,
          );
          return { id: itemId };
        }

        if (item.storeId !== storeId) {
          this.logger.warn(
            `[Transaction] Forbidden: Item ${itemId} does not belong to store ${storeId}. Cannot delete.`,
          );
          throw new ForbiddenException(
            `Menu item (ID: ${itemId}) does not belong to the specified store (ID: ${storeId}). Cannot delete.`,
          );
        }

        this.logger.debug(`[Transaction] Deleting menu item ${itemId}`);
        await tx.menuItem.delete({
          where: { id: itemId },
        });
        this.logger.log(`Deleted menu item ${itemId} from store ${storeId}`);

        return { id: itemId };
      });
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        this.logger.warn(
          `Deletion pre-check failed for item ${itemId} in store ${storeId}: ${error.message}`,
        );
        throw error;
      }
      this.logger.error(
        `Unexpected error deleting menu item ${itemId} for store ${storeId}`,
        error,
      );
      throw new InternalServerErrorException('Failed to delete menu item.');
    }
  }

  // =======================================================================
  // Private Helper Methods
  // =======================================================================

  /**
   * Creates customization groups and their options for a menu item.
   * Assumes call is within a transaction.
   */
  private async createCustomizations(
    tx: Prisma.TransactionClient,
    menuItemId: number,
    groupDtos: UpsertCustomizationGroupDto[],
  ): Promise<void> {
    this.logger.debug(
      `[createCustomizations] Processing ${groupDtos?.length ?? 0} group DTOs for item ${menuItemId}`,
    );
    for (const groupDto of groupDtos) {
      if (!groupDto.options?.length) {
        this.logger.warn(
          `[createCustomizations] Skipping group "${groupDto.name}" for item ${menuItemId} because it has no options.`,
        );
        continue;
      }

      this.logger.debug(
        `[createCustomizations] Creating group "${groupDto.name}" for item ${menuItemId}`,
      );
      const group = await tx.customizationGroup.create({
        data: {
          menuItemId: menuItemId,
          name: groupDto.name,
          required: groupDto.required ?? false,
          minSelectable: groupDto.minSelectable ?? (groupDto.required ? 1 : 0),
          maxSelectable: groupDto.maxSelectable ?? 1,
        },
        select: { id: true },
      });
      this.logger.debug(`[createCustomizations] Created group ID: ${group.id}`);

      this.logger.debug(
        `[createCustomizations] Creating ${groupDto.options.length} options for group ${group.id}`,
      );
      await tx.customizationOption.createMany({
        data: groupDto.options.map((optionDto) => ({
          customizationGroupId: group.id,
          name: optionDto.name,
          additionalPrice: optionDto.additionalPrice ?? 0,
        })),
      });
    }
  }

  /**
   * Finds a category by ID/Name for the store, or creates it if not found.
   * Calculates the next sortOrder for new categories.
   * Assumes call is within a transaction.
   */
  private async upsertCategory(
    tx: Prisma.TransactionClient,
    catDto: UpsertCategoryDto,
    storeId: number,
  ): Promise<number> {
    this.logger.debug(
      `[upsertCategory] Processing category DTO for store ${storeId}`,
      catDto.id ? `with ID ${catDto.id}` : `with name "${catDto.name}"`,
    );
    if (catDto.id) {
      if (!catDto.name) {
        throw new BadRequestException(
          'Category name is required when updating by ID.',
        );
      }
      this.logger.debug(
        `[upsertCategory] Attempting to update category ${catDto.id} in store ${storeId}`,
      );
      const result = await tx.category.updateMany({
        where: { id: catDto.id, storeId: storeId },
        data: { name: catDto.name },
      });

      if (result.count === 0) {
        this.logger.warn(
          `[upsertCategory] Update failed: Category ${catDto.id} not found or doesn't belong to store ${storeId}.`,
        );
        throw new NotFoundException(
          `Category with ID ${catDto.id} not found in store ID ${storeId}, or update failed.`,
        );
      }
      this.logger.debug(
        `[upsertCategory] Successfully updated category ${catDto.id}`,
      );
      return catDto.id;
    } else {
      if (!catDto.name) {
        throw new BadRequestException(
          'Category name is required to find or create a category.',
        );
      }

      this.logger.debug(
        `[upsertCategory] Searching for existing category "${catDto.name}" in store ${storeId}`,
      );
      const existingCategory = await tx.category.findUnique({
        where: { storeId_name: { storeId, name: catDto.name } },
        select: { id: true },
      });

      if (existingCategory) {
        this.logger.debug(
          `[upsertCategory] Found existing category ID: ${existingCategory.id}`,
        );
        return existingCategory.id;
      } else {
        this.logger.debug(
          `[upsertCategory] Category "${catDto.name}" not found, creating new one in store ${storeId}`,
        );
        const maxSort = await tx.category.aggregate({
          where: { storeId },
          _max: { sortOrder: true },
        });
        const newSortOrder = (maxSort._max.sortOrder ?? -1) + 1;
        this.logger.debug(
          `[upsertCategory] New category sort order: ${newSortOrder}`,
        );

        const newCat = await tx.category.create({
          data: {
            name: catDto.name,
            storeId,
            sortOrder: newSortOrder,
          },
          select: { id: true },
        });
        this.logger.log(
          `[upsertCategory] Created new category "${catDto.name}" with ID: ${newCat.id}`,
        );
        return newCat.id;
      }
    }
  }

  /**
   * Synchronizes customization groups: Deletes removed, updates existing, creates new.
   * Assumes call is within a transaction.
   */
  private async syncCustomizationGroups(
    tx: Prisma.TransactionClient,
    menuItemId: number,
    existingGroups: ExistingCustomizationGroup[],
    groupDtos: UpsertCustomizationGroupDto[] | null | undefined,
  ): Promise<void> {
    this.logger.debug(
      `[syncCustomizationGroups] Starting sync for item ${menuItemId}`,
    );
    const dtoGroupsMap = new Map(
      (groupDtos ?? [])
        .filter((g) => g != null)
        .map((g) => [g.id ?? Symbol(`new_${g.name}_${Math.random()}`), g]),
    );
    const existingGroupIds = new Set(existingGroups.map((g) => g.id));
    this.logger.debug(
      `[syncCustomizationGroups] Found ${existingGroups.length} existing groups and ${dtoGroupsMap.size} groups in DTO.`,
    );

    const groupsToDelete = existingGroups.filter(
      (g) => !dtoGroupsMap.has(g.id),
    );
    if (groupsToDelete.length > 0) {
      const idsToDelete = groupsToDelete.map((g) => g.id);
      this.logger.debug(
        `[syncCustomizationGroups] Deleting ${groupsToDelete.length} groups: ${idsToDelete.join(', ')}`,
      );
      await tx.customizationGroup.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    }

    for (const [key, groupDto] of dtoGroupsMap.entries()) {
      if (!groupDto.name) {
        this.logger.warn(
          `[syncCustomizationGroups] Skipping group due to missing name for item ${menuItemId}.`,
        );
        continue;
      }

      const isExistingGroup =
        typeof key === 'number' && existingGroupIds.has(key);

      if (isExistingGroup) {
        const groupId = key;
        this.logger.debug(
          `[syncCustomizationGroups] Updating existing group ID: ${groupId}`,
        );
        const existingGroup = existingGroups.find((g) => g.id === groupId)!;
        await tx.customizationGroup.update({
          where: { id: groupId },
          data: {
            name: groupDto.name,
            required: groupDto.required ?? false,
            minSelectable:
              groupDto.minSelectable ?? (groupDto.required ? 1 : 0),
            maxSelectable: groupDto.maxSelectable ?? 1,
          },
        });
        await this.syncCustomizationOptions(
          tx,
          groupId,
          existingGroup.customizationOptions,
          groupDto.options,
        );
      } else {
        if (!groupDto.options?.length) {
          this.logger.warn(
            `[syncCustomizationGroups] Skipping creation of new group "${groupDto.name}" for item ${menuItemId} because it has no options.`,
          );
          continue;
        }
        this.logger.debug(
          `[syncCustomizationGroups] Creating new group "${groupDto.name}" for item ${menuItemId}`,
        );
        const newGroup = await tx.customizationGroup.create({
          data: {
            menuItemId: menuItemId,
            name: groupDto.name,
            required: groupDto.required ?? false,
            minSelectable:
              groupDto.minSelectable ?? (groupDto.required ? 1 : 0),
            maxSelectable: groupDto.maxSelectable ?? 1,
          },
          select: { id: true },
        });
        this.logger.debug(
          `[syncCustomizationGroups] Created new group ID: ${newGroup.id}. Creating options...`,
        );
        await tx.customizationOption.createMany({
          data: groupDto.options.map((optDto) => ({
            customizationGroupId: newGroup.id,
            name: optDto.name,
            additionalPrice: optDto.additionalPrice ?? 0,
          })),
        });
      }
    }
    this.logger.debug(
      `[syncCustomizationGroups] Finished sync for item ${menuItemId}`,
    );
  }

  /**
   * Synchronizes customization options within a group: Deletes removed, updates existing, creates new.
   * Assumes call is within a transaction.
   */
  private async syncCustomizationOptions(
    tx: Prisma.TransactionClient,
    groupId: number,
    existingOptions: Array<{ id: number }>,
    optionDtos:
      | Array<{
          id?: number;
          name: string;
          additionalPrice?: number | Decimal | null;
        }>
      | null
      | undefined,
  ): Promise<void> {
    this.logger.debug(
      `[syncCustomizationOptions] Starting sync for group ${groupId}`,
    );
    const dtoOptionsMap = new Map(
      (optionDtos ?? [])
        .filter((o) => o != null)
        .map((o) => [o.id ?? Symbol(`new_${o.name}_${Math.random()}`), o]),
    );
    const existingOptionIds = new Set(existingOptions.map((o) => o.id));
    this.logger.debug(
      `[syncCustomizationOptions] Found ${existingOptions.length} existing options and ${dtoOptionsMap.size} options in DTO for group ${groupId}.`,
    );

    const optionsToDelete = existingOptions.filter(
      (o) => !dtoOptionsMap.has(o.id),
    );
    if (optionsToDelete.length > 0) {
      const idsToDelete = optionsToDelete.map((o) => o.id);
      this.logger.debug(
        `[syncCustomizationOptions] Deleting ${optionsToDelete.length} options from group ${groupId}: ${idsToDelete.join(', ')}`,
      );
      await tx.customizationOption.deleteMany({
        where: { id: { in: idsToDelete } },
      });
    }

    for (const [key, optionDto] of dtoOptionsMap.entries()) {
      if (!optionDto.name) {
        this.logger.warn(
          `[syncCustomizationOptions] Skipping option due to missing name for group ${groupId}.`,
        );
        continue;
      }

      const isExistingOption =
        typeof key === 'number' && existingOptionIds.has(key);

      if (isExistingOption) {
        const optionId = key;
        this.logger.debug(
          `[syncCustomizationOptions] Updating existing option ID: ${optionId} in group ${groupId}`,
        );
        await tx.customizationOption.update({
          where: { id: optionId },
          data: {
            name: optionDto.name,
            additionalPrice: optionDto.additionalPrice ?? 0,
          },
        });
      } else {
        this.logger.debug(
          `[syncCustomizationOptions] Creating new option "${optionDto.name}" in group ${groupId}`,
        );
        await tx.customizationOption.create({
          data: {
            customizationGroupId: groupId,
            name: optionDto.name,
            additionalPrice: optionDto.additionalPrice ?? 0,
          },
        });
      }
    }
    this.logger.debug(
      `[syncCustomizationOptions] Finished sync for group ${groupId}`,
    );
  }
}
