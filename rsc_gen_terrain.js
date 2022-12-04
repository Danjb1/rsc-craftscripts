/*
 * CraftScript to fill the region with terrain from RuneScape Classic.
 *
 * Based on:
 * - 2D-Landscape-Editor: https://github.com/Open-RSC/2D-Landscape-Editor
 * - rsc-landscape: https://github.com/2003scape/rsc-landscape
 *
 * Useful locations:
 * - Origin (top-left):     /tp 240 80 432
 * - Lumbridge:             /tp 900 80 656
 *
 * ---
 *
 * USAGE:
 *
 *  /cs rsc_gen_terrain <landscape_filename> <region|full|chunk> [--clean]
 *
 * ---
 *
 * EXAMPLES:
 *
 * Generate the entire map:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data full
 *
 *      This may require a tweak to `worldedit.properties`:
 *      scripting-timeout=300000
 *
 *      Followed by:
 *      /worldedit reload
 *
 *      After generating the map it takes a long time for the chunks to update,
 *      and no other commands can be run in the meantime.
 *
 * Generate sector at the current chunk:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data chunk
 *
 * Generate sectors to fill the selected region:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data region
 */

importPackage(Packages.java.io);
importPackage(Packages.java.lang.reflect);
importPackage(Packages.java.nio);
importPackage(Packages.java.util.zip);
importPackage(Packages.com.sk89q.worldedit);
importPackage(Packages.com.sk89q.worldedit.blocks);
importPackage(Packages.com.sk89q.worldedit.math);
importClass(Packages.com.sk89q.worldedit.util.TreeGenerator);

const SEA_LEVEL = 63;
const BEDROCK_LEVEL = 60;
const MAX_TERRAIN_HEIGHT = 9;

// If a tile has a roof, it will take the place of the topmost wall block.
// Otherwise, we keep the walls high so that they merge with the layer above.
const WALL_HEIGHT = 5;
const ROOF_HEIGHT = WALL_HEIGHT;

// TODO: Layer 4 is underground!
const NUM_LAYERS = 3;

const SECTOR_SIZE = 48;

// Sector filenames start from h0x48y37
const MIN_SECTOR_X = 48;
const MIN_SECTOR_Y = 37;

const MAX_SECTOR_X = 68;
const MAX_SECTOR_Y = 57;
const NUM_SECTORS_X = MAX_SECTOR_X - MIN_SECTOR_X;

////////////////////////////////////////////////////////////////////////////////
// Minecraft world
////////////////////////////////////////////////////////////////////////////////

function processSector(sector, sectorX, sectorY, clean) {
    // Find the sector origin, converted to Minecraft's co-ordinate system
    var sectorMinBlockPos = getMinBlockPosForSector(sectorX, sectorY);

    // Clean chunk
    // TODO: This prevents trees from generating!
    if (clean) {
        for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
            for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
                var blockPos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);
                for (var height = 0; height < 30; height++) {
                    blockPos = blockPos.withY(BEDROCK_LEVEL + height);
                    blocks.setBlock(blockPos, context.getBlock("air"));
                }
            }
        }
    }

    /*
     * We have to build structures in a careful order, otherwise floors might
     * overwrite wall blocks of the previous layer, or walls placed in
     * neighbouring tiles might overwrite the roof blocks there.
     */

    // Build floors
    for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
        for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
            buildFloors(sectorMinBlockPos, sector, tileX, tileY);
        }
    }

    // Build walls
    for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
        for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
            buildWalls(sectorMinBlockPos, sector, tileX, tileY);
        }
    }

    // Build roofs
    for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
        for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
            buildRoofs(sectorMinBlockPos, sector, tileX, tileY);
        }
    }

    // Reverse iteration code, if needed...
    // for (var tileX = SECTOR_SIZE - 1; tileX >= 0; tileX--) {
    //     for (var tileY = SECTOR_SIZE - 1; tileY >= 0; tileY--) {
    //     }
    // }
}

function buildFloors(sectorMinBlockPos, sector, tileX, tileY) {
    // Find block position corresponding to tile (at lowest possible point)
    var blockPos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);

    // Build each layer in turn
    for (var layer = 0; layer < NUM_LAYERS; layer++) {
        var tile = sector[layer][tileX][tileY];

        // Data structure to store Minecraft-specific data
        tile.mc = {};

        // Get tile overlay settings
        if (tile.groundOverlay) {
            tile.mc.overlaySettings = getOverlaySettings(tile.groundOverlay);
        }

        // Pick the block type based on the tile color
        var blockType = getBlockTypeFromPalette(tile.groundTexture);

        // Determine desired elevation and place supporting blocks
        if (layer === 0) {
            // Place bedrock as a base
            var bedrock = context.getBlock("bedrock");
            blocks.setBlock(blockPos, bedrock);

            // Pick the block type to be used by any supporting blocks
            var supportType = blockType == context.getBlock("dirt_path")
                ? context.getBlock("dirt")
                : blockType;

            // RSC elevation seems to range from: 0 (highest point) to 256 (lowest point),
            // which we map to the range: 9 (highest point) to 1 (lowest point).
            tile.mc.elevation = 5 + ((tile.groundElevation) / 32);
            if (tile.mc.overlaySettings && tile.mc.overlaySettings.overrideElevation) {
                tile.mc.elevation = tile.mc.overlaySettings.overrideElevation;
            }

            // Place supporting blocks up to the desired elevation
            for (var i = 1; i < tile.mc.elevation; i++) {
                blockPos = blockPos.withY(BEDROCK_LEVEL + i);
                blocks.setBlock(blockPos, supportType);
            }
        } else {
            var groundElevation = sector[0][tileX][tileY].mc.elevation;
            tile.mc.elevation = groundElevation + layer * WALL_HEIGHT;
        }

        // Place ground
        if (layer === 0) {
            blockPos = blockPos.withY(BEDROCK_LEVEL + tile.mc.elevation);
            blocks.setBlock(blockPos, blockType);
        }

        // Place overlay block
        if (isOverlayPermitted(layer, tile.mc.overlaySettings)) {
            var overlayY = BEDROCK_LEVEL + tile.mc.elevation;
            if (!tile.mc.overlaySettings.replaceGround) {
                overlayY += 1;
            }
            blockPos = blockPos.withY(overlayY);
            blocks.setBlock(blockPos, tile.mc.overlaySettings.block);
        }
    }
}

function buildWalls(sectorMinBlockPos, sector, tileX, tileY) {
    // Find block position corresponding to tile (at lowest possible point)
    var blockPos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);

    var groundOverlaySettings = sector[0][tileX][tileY].mc.overlaySettings;

    // Build each layer in turn
    for (var layer = 0; layer < NUM_LAYERS; layer++) {
        var tile = sector[layer][tileX][tileY];

        tile.mc.indoors = isTileIndoors(tile.mc.overlaySettings, groundOverlaySettings);
        var wallType = getWallType(tile);

        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);

            // Determine the wall's facing
            var facing;
            if (tile.mc.indoors) {
                if (tile.topBorderWall) {
                    facing = "south";
                } else {
                    facing = "west";
                }
            } else {
                if (tile.topBorderWall) {
                    facing = "north";
                } else {
                    facing = "east";
                }
            }

            // Get wall settings
            var wallSettings = getWallSettings(tile, wallType, facing);

            // Place walls at the appropriate locations.
            // This is essentially unsolveable since walls in RS are 2D, but we
            // take a best-effort approach of always placing walls to the
            // north-east of the tile that defines them.
            // TODO: This causes problems at sector boundaries.
            // TODO: The shifted walls can overlap with adjacent objects.
            // TODO: The shifted walls can overwrite doors (e.g. Crafting Guild)
            if (tile.mc.indoors) {
                if (tile.rightBorderWall && tile.topBorderWall) {
                    // Inside corner: we need to place THREE neighbouring blocks
                    // (the 2 shifted edges, plus a corner block).
                    // If this wall has a door, it should only be placed once!
                    var savedDoorBlock = wallSettings.doorBlock;
                    wallSettings.doorBlock = null;
                    var wallPos = blockPos.add(1, 0, 0);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                    wallPos = blockPos.add(1, 0, -1);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                    wallSettings.doorBlock = savedDoorBlock;
                    wallPos = blockPos.add(0, 0, -1);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                } else if (tile.topBorderWall) {
                    // Top wall: shift up
                    var wallPos = blockPos.add(0, 0, -1);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                } else if (tile.rightBorderWall) {
                    // Right wall: shift right
                    var wallPos = blockPos.add(1, 0, 0);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                } else {
                    // Diagonal wall: just place a wall at the current tile
                    buildWall(sector, tileX, tileY, layer, blockPos, tile.mc.elevation, wallSettings);
                }
            } else /* outdoor wall */ {
                if (tile.topBorderWall) {
                    // Top wall: shift up
                    var wallPos = blockPos.add(0, 0, -1);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                } else if (tile.rightBorderWall) {
                    // Right wall: shift right
                    var wallPos = blockPos.add(1, 0, 0);
                    buildWall(sector, tileX, tileY, layer, wallPos, tile.mc.elevation, wallSettings);
                } else {
                    // Diagonal wall: just place a wall at the current tile
                    buildWall(sector, tileX, tileY, layer, blockPos, tile.mc.elevation, wallSettings);
                }
            }
        }

        // Place objects
        if (wallType >= 48000) {
            var objectId = wallType - 48000;
            placeObject(objectId, blockPos.withY(BEDROCK_LEVEL + tile.mc.elevation));
        }
    }
}

function getWallType(tile) {
    return tile.topBorderWall || tile.rightBorderWall || tile.diagonalWalls;
}

function isWall(wallType) {
    return wallType > 0 && wallType < 48000;
}

function normalizeWallType(wallType) {
    if (wallType >= 48000) {
        return wallType - 48000;
    } else if (wallType >= 12000) {
        return wallType - 12000;
    }
    return wallType;
}

function buildRoofs(sectorMinBlockPos, sector, tileX, tileY) {
    // Find block position corresponding to tile (at lowest possible point)
    var blockPos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);

    // Build each layer in turn
    for (var layer = 0; layer < NUM_LAYERS; layer++) {
        var tile = sector[layer][tileX][tileY];

        if (tile.roofTexture) {
            var roofY = BEDROCK_LEVEL + tile.mc.elevation + ROOF_HEIGHT;
            blockPos = blockPos.withY(roofY);

            // If this is the edge of roof, place a roof edge over the
            // neighbouring blocks
            try {
                var northTile = sector[layer][tileX][tileY - 1];
                var eastTile = sector[layer][tileX - 1][tileY];

                if (!northTile.roofTexture && !eastTile.roofTexture) {
                    // North-eastern tile is the corner of the roof
                    var roofPos = blockPos.add(1, 0, -1);
                    placeRoof(tile.roofTexture, roofPos, "west,shape=outer_left");
                    roofPos = blockPos.add(1, 0, 0);
                    placeRoof(tile.roofTexture, roofPos, "west");
                    roofPos = blockPos.add(0, 0, -1);
                    placeRoof(tile.roofTexture, roofPos, "south");
                } else if (!northTile.roofTexture) {
                    // Northern tile is the top edge of the roof
                    var roofPos = blockPos.add(0, 0, -1);
                    placeRoof(tile.roofTexture, roofPos, "south");
                } else if (!eastTile.roofTexture) {
                    // Eastern tile is the right edge of the roof
                    var roofPos = blockPos.add(1, 0, 0);
                    placeRoof(tile.roofTexture, roofPos, "west");
                } else {
                    // Central roof block
                    placeRoof(tile.roofTexture, blockPos, null);
                }
            } catch (err) {
                // Tried to cross a sector boundary. Ignore this for now.
                // Roofs at sector boundaries will look messed up.
                placeRoof(tile.roofTexture, blockPos, null);
            }

            // Finally, place a roof over the current tile
            placeRoof(tile.roofTexture, blockPos, null);

        } else if (tile.topBorderWall) {
            // This tile is an outside wall, so its neighbour might be the edge
            // of a roof
            try {
                var northTile = sector[layer][tileX][tileY - 1];
                var northEastTile = sector[layer][tileX - 1][tileY - 1];

                if (northTile.roofTexture) {
                    var roofY = BEDROCK_LEVEL + tile.mc.elevation + ROOF_HEIGHT;

                    if (!northEastTile.roofTexture) {
                        // North-eastern tile is the bottom-right corner of the roof
                        var roofPos = blockPos.withY(roofY).add(1, 0, -1);
                        placeRoof(northTile.roofTexture, roofPos, "north,shape=outer_left");
                    }

                    // Northern tile is the bottom edge of the roof
                    var roofPos = blockPos.withY(roofY).add(0, 0, -1);
                    placeRoof(northTile.roofTexture, roofPos, "north");
                }
            } catch (err) {
                // Tried to cross a sector boundary. Ignore this for now.
                // Roofs at sector boundaries will look messed up.
            }
        } else if (tile.rightBorderWall) {
            // This tile is an outside wall, so its neighbour might be the edge
            // of a roof
            try {
                var eastTile = sector[layer][tileX - 1][tileY];
                var northEastTile = sector[layer][tileX - 1][tileY - 1];

                if (eastTile.roofTexture) {
                    var roofY = BEDROCK_LEVEL + tile.mc.elevation + ROOF_HEIGHT;

                    if (!northEastTile.roofTexture) {
                        // North-eastern tile is the top-left corner of the roof
                        var roofPos = blockPos.withY(roofY).add(1, 0, -1);
                        placeRoof(eastTile.roofTexture, roofPos, "south,shape=outer_left");
                    }

                    // Eastern tile is the left edge of the roof
                    var roofPos = blockPos.withY(roofY).add(1, 0, 0);
                    placeRoof(eastTile.roofTexture, roofPos, "east");
                }
            } catch (err) {
                // Tried to cross a sector boundary. Ignore this for now.
                // Roofs at sector boundaries will look messed up.
            }
        } else {
            try {
                var northEastTile = sector[layer][tileX - 1][tileY - 1];
                if (northEastTile.roofTexture) {
                    var roofY = BEDROCK_LEVEL + tile.mc.elevation + ROOF_HEIGHT;
                    // North-eastern tile is the bottom-left corner of the roof
                    var roofPos = blockPos.withY(roofY).add(1, 0, -1);
                    placeRoof(northEastTile.roofTexture, roofPos, "east,shape=outer_left");
                }
            } catch (err) {
                // Tried to cross a sector boundary. Ignore this for now.
                // Roofs at sector boundaries will look messed up.
            }
        }
    }
}

// See:
// https://github.com/Open-RSC/2D-Landscape-Editor/blob/main/src/main/java/org/openrsc/editor/gui/graphics/TileRenderer.java#L46
// https://github.com/2003scape/rsc-landscape/blob/master/src/terrain-colours.js
// TODO: Cache block types
function getBlockTypeFromPalette(paletteIndex) {
    if (paletteIndex < 16) {
        return context.getBlock("stone");
    } else if (paletteIndex < 48) {
        return context.getBlock("lime_terracotta");
    } else if (paletteIndex < 80) {
        return context.getBlock("grass_block");
    } else if (paletteIndex < 96) {
        return context.getBlock("green_concrete_powder");
    } else if (paletteIndex < 104) {
        return context.getBlock("lime_terracotta");
    } else if (paletteIndex < 144) {
        return context.getBlock("dirt_path");
    } else if (paletteIndex < 164) {
        return context.getBlock("packed_mud");
    } else if (paletteIndex < 176) {
        return context.getBlock("dirt");
    } else if (paletteIndex < 208) {
        return context.getBlock("coarse_dirt");
    } else if (paletteIndex < 216) {
        return context.getBlock("podzol");
    }
    return context.getBlock("grass_block");
}

function getOverlaySettings(groundOverlay) {
    var overlaySettings = {
        block: context.getBlock("cyan_wool"),
        indoors: false,
        replaceGround: true,
        isVoid: false
    };

    if (groundOverlay === 1) {
        // Path
        overlaySettings.block = context.getBlock("gravel");
    } else if (groundOverlay === 2) {
        // Water
        overlaySettings.block = context.getBlock("water");
        overlaySettings.replaceGround = false;
        overlaySettings.overrideElevation = SEA_LEVEL - BEDROCK_LEVEL;
    } else if (groundOverlay === 3) {
        // Wood floor
        overlaySettings.block = context.getBlock("spruce_planks");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 4) {
        // Bridge (needs to blend with wood floor, above)
        overlaySettings.block = context.getBlock("dark_oak_planks");
    } else if (groundOverlay === 5) {
        // Swamp
        overlaySettings.block = context.getBlock("smooth_stone");
    } else if (groundOverlay === 6) {
        // Red carpet
        overlaySettings.block = context.getBlock("red_wool");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 7) {
        // Floor tiles
        overlaySettings.block = context.getBlock("muddy_mangrove_roots");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 8) {
        // Void
        overlaySettings.block = context.getBlock("black_concrete");
        overlaySettings.isVoid = true;
    } else if (groundOverlay === 9) {
        // Cliff
        overlaySettings.block = context.getBlock("andesite");
    } else if (groundOverlay === 11) {
        // Lava
        overlaySettings.block = context.getBlock("lava");
    } else if (groundOverlay === 12) {
        // Sloped bridge (Mage Arena)
        overlaySettings.block = context.getBlock("spruce_planks");
    } else if (groundOverlay === 13) {
        // Cyan carpet
        overlaySettings.block = context.getBlock("cyan_wool");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 14) {
        // Star summoning circle
        overlaySettings.block = context.getBlock("gray_glazed_terracotta");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 15) {
        // Purple carpet
        overlaySettings.block = context.getBlock("purple_wool");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 16) {
        // Digsite hole (?)
        overlaySettings.block = context.getBlock("black_concrete");
        overlaySettings.isVoid = true;
    } else if (groundOverlay === 17) {
        // Marble
        overlaySettings.block = context.getBlock("chiseled_quartz_block");
    } else if (groundOverlay === 18) {
        // Tree Gnome Village floor
        overlaySettings.block = context.getBlock("spruce_planks");
    } else if (groundOverlay === 19) {
        // Natural bridge (south of Tai Bwo Wannai)
        // (not sure what this is supposed to be exactly)
        overlaySettings.block = context.getBlock("gravel");
    } else if (groundOverlay === 20) {
        // Log bridge
        overlaySettings.block = context.getBlock("oak_log");
    } else if (groundOverlay === 21) {
        // Log bridge
        overlaySettings.block = context.getBlock("oak_log");
    } else if (groundOverlay === 23) {
        // Digsite
        overlaySettings.block = context.getBlock("brown_wool");
    } else if (groundOverlay === 24) {
        // Cliff (mud)
        // (overlay seems redundant)
        overlaySettings.block = context.getBlock("air");
    } else if (groundOverlay === 250) {
        // Out of bounds area
        overlaySettings.block = context.getBlock("black_concrete");
    } else {
        player.print("Unknown overlay: " + groundOverlay);
    }

    return overlaySettings;
}

function isOverlayPermitted(layer, overlaySettings) {
    if (!overlaySettings) {
        return false;
    }

    if (layer > 0 && overlaySettings.isVoid) {
        // Ignore void blocks on upper storeys
        return false;
    }

    return true;
}

function isTileIndoors(overlaySettings, groundOverlaySettings) {
    if (!overlaySettings) {
        // Upper storey tiles with no floor (e.g. high-ceilinged rooms) should
        // still count as indoors
        return groundOverlaySettings && groundOverlaySettings.indoors;
    }

    return overlaySettings.indoors;
}

function getWallSettings(tile, wallType, facing) {
    var wallSettings = {
        block: context.getBlock("red_wool"),
        height: WALL_HEIGHT,
        doorBlock: null,
        windowBlock: null,
        cornerBlock: null
    };

    // TODO: Comment where Doorways are located

    if (wallType === 1) {
        // Stone wall
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 2) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 3) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 4) {
        // Stone wall window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else {
            wallSettings.windowBlock = context.getBlock("glass_pane" + getWindowProperties(facing));
        }
    } else if (wallType === 5) {
        // Wooden fence
        wallSettings.block = context.getBlock("jungle_fence");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 6) {
        // Metal fence
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 7) {
        // Stained glass window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else {
            wallSettings.windowBlock = context.getBlock("glass_pane" + getWindowProperties(facing));
        }
    } else if (wallType === 8) {
        // Stone wall (extra tall?)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 9) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 11) {
        // Stone fence (short)
        wallSettings.block = context.getBlock("stone_brick_wall");
        wallSettings.height = 1;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 14) {
        // Stone wall window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else {
            wallSettings.windowBlock = context.getBlock("glass_pane" + getWindowProperties(facing));
        }
    } else if (wallType === 15) {
        // Plaster / panelled wall
        wallSettings.block = context.getBlock("mushroom_stem");
        wallSettings.cornerBlock = context.getBlock("stripped_jungle_log");
    } else if (wallType === 16) {
        // Panelled window
        wallSettings.block = context.getBlock("mushroom_stem");
        wallSettings.cornerBlock = context.getBlock("stripped_jungle_log");
        wallSettings.windowBlock = context.getBlock("jungle_trapdoor[open=true,facing=" + facing + "]");
    } else if (wallType === 17) {
        // Opening (with overhang above)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 19) {
        // Slimy wall
        wallSettings.block = context.getBlock("mossy_stone_bricks");
    } else if (wallType === 23) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 24) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 25) {
        // Invisible? (Wilderness, Deserted Keep)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 31) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 33) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 35) {
        // Stone wall window (arch)
        wallSettings.block = context.getBlock("stone_bricks");
        wallSettings.windowBlock = context.getBlock("air");
    } else if (wallType === 37) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 38) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 39) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 40) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 41) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 42) {
        // Broken stone wall
        wallSettings.block = context.getBlock("cracked_stone_bricks");
        wallSettings.height = Math.random() * WALL_HEIGHT;
    } else if (wallType === 43) {
        // Brick wall (Shantay Pass)
        wallSettings.block = context.getBlock("granite");
    } else if (wallType === 44) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 45) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 49) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 50) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 51) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 55) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 57) {
        // Wooden wall
        wallSettings.block = context.getBlock("spruce_planks");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 61) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 63) {
        // Stone fence
        wallSettings.block = context.getBlock("stone_brick_wall");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 67) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 69) {
        // Doorway (Crafting Guild)
        setDoorway(facing, wallSettings);
    } else if (wallType === 77) {
        // Interior stone wall (Brimhaven)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 75) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 76) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 78) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 79) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 80) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 81) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 82) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 83) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 87) {
        // Invisible wall
        wallSettings.block = context.getBlock("barrier");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 94) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 95) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 97) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 98) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 99) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 100) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 102) {
        // Gap in fence
        // TODO: This should probably be a gate
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 101) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 110) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 111) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 113) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 114) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 115) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 116) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 117) {
        // Draynor Manor - upper wall (?)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 120) {
        // Wooden wall
        wallSettings.block = context.getBlock("spruce_planks");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 121) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 123) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 124) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 127) {
        // Wooden wall - glass window
        wallSettings.block = context.getBlock("spruce_planks");
        wallSettings.windowBlock = context.getBlock("glass_pane" + getWindowProperties(facing));
    } else if (wallType === 128) {
        // Wooden fence (extra short)
        wallSettings.block = context.getBlock("jungle_fence");
        wallSettings.height = 1;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 139) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 142) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 145) {
        // Wooden wall - wood window
        wallSettings.block = context.getBlock("spruce_planks");
        wallSettings.windowBlock = context.getBlock("oak_trapdoor[open=true,facing=" + facing + "]");
    } else if (wallType === 146) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 147) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 148) {
        // Opening (Yanille tower)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 149) {
        // Opening (Yanille tower)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 150) {
        // Opening (Yanille tower)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 151) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 153) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 162) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 164) {
        // Agility training area wall (?)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 165) {
        // Agility training area wall (?)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 166) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 176) {
        // Straw hut wall
        wallSettings.block = context.getBlock("smooth_sandstone");
    } else if (wallType === 177) {
        // Opening (with overhang above)
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 178) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 179) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 182) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 183) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 184) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 185) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 186) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 187) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 194) {
        // Fence, east of Baxtorian falls (doesn't appear in world viewer!)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 195) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 196) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 197) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 198) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 199) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else if (wallType === 200) {
        // Gap in fence
        // TODO: This should probably be a gate
        wallSettings.block = context.getBlock("air");
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 202) {
        // Broken bridge south of Yanille (?)
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
        wallSettings.ensureAboveGround = true;
    } else if (wallType === 206) {
        // Doorway
        setDoorway(facing, wallSettings);
    } else {
        player.print("Unknown wall type: " + wallType);
    }

    return wallSettings;
}

function setDoorway(facing, wallSettings) {
    // Doors will try to blend with the surrounding blocks, but otherwise, we
    // default to something inoffensive.
    wallSettings.block = context.getBlock("glass");
    wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    wallSettings.ensureAboveGround = true;
}

function getAxisFromFacing(facing) {
    return (facing === "east" || facing === "west") ? "x" : "z";
}

function getWindowProperties(facing) {
    if (facing === "east" || facing === "west") {
        return "[north=true,south=true]";
    } else {
        return "[east=true,west=true]";
    }
}

function buildWall(sector, tileX, tileY, layer, wallPos, elevation, wallSettings) {
    var startY = 0;

    // Determine wall start
    if (wallSettings.ensureAboveGround) {
        startY = 1;
    } else if (layer === 0) {
        // Start underground in case the wall is on a steep slope
        startY = -5;
    }

    // Determine wall end
    var endY = wallSettings.height;

    // Build the wall
    for (var i = startY; i <= endY; i++) {
        wallPos = wallPos.withY(BEDROCK_LEVEL + elevation + i);

        if (wallSettings.doorBlock) {
            if (i === 1) {
                // Door (lower)
                // TODO: Place an air block in front of the door in case it
                // is embedded in the ground.
                var doorBlock = wallSettings.doorBlock.replace("]", ",half=lower]");
                blocks.setBlock(wallPos, context.getBlock(doorBlock));
            } else if (i === 2) {
                // Door (upper)
                var doorBlock = wallSettings.doorBlock.replace("]", ",half=upper]");
                blocks.setBlock(wallPos, context.getBlock(doorBlock));
            } else {
                var wallBlock = getNeighbouringWallBlock(sector, layer, tileX, tileY);
                if (wallBlock) {
                    blocks.setBlock(wallPos, wallBlock);
                } else {
                    blocks.setBlock(wallPos, wallBlock);
                }
            }
        } else if (wallSettings.windowBlock && i > 1 && i < wallSettings.height - 1) {
            // Window
            blocks.setBlock(wallPos, wallSettings.windowBlock);
        } else if (wallSettings.cornerBlock && i % 4 === 0) {
            blocks.setBlock(wallPos, wallSettings.cornerBlock);
        } else {
            blocks.setBlock(wallPos, wallSettings.block);
        }
    }
}

function getNeighbouringWallBlock(sector, layer, tileX, tileY) {
    try {
        // North
        var tile = sector[layer][tileX][tileY - 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // North-east
        var tile = sector[layer][tileX - 1][tileY - 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // East
        var tile = sector[layer][tileX - 1][tileY];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // South-east
        var tile = sector[layer][tileX - 1][tileY + 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // South
        var tile = sector[layer][tileX][tileY + 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // South-west
        var tile = sector[layer][tileX + 1][tileY + 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // West
        var tile = sector[layer][tileX + 1][tileY];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    try {
        // North-west
        var tile = sector[layer][tileX + 1][tileY - 1];
        var wallType = getWallType(tile);
        if (isWall(wallType)) {
            wallType = normalizeWallType(wallType);
            var wallSettings = getWallSettings(tile, wallType, null);
            if (wallSettings.block && !wallSettings.doorBlock) {
                return wallSettings.block;
            }
        }
    } catch (err) { /* Crossed a sector boundary */ }

    return null;
}

function placeObject(objectId, groundPos) {
    var blockPos = groundPos.add(0, 1, 0);
    if (objectId === 1) {
        // Tree
        placeTree(blockPos);
    } else if (objectId === 2) {
        // Shrub
        blocks.setBlock(blockPos, context.getBlock("fern"));
    } else if (objectId === 3) {
        // Well
        blocks.setBlock(blockPos, context.getBlock("water_cauldron[level=3]"));
    } else if (objectId === 4) {
        // Small table
        blocks.setBlock(blockPos, context.getBlock("crafting_table"));
    } else if (objectId === 5) {
        // Treestump
        blocks.setBlock(blockPos, context.getBlock("oak_log"));
    } else if (objectId === 7) {
        // Range
        blocks.setBlock(blockPos, context.getBlock("furnace"));
    } else if (objectId === 6) {
        // Ladder
        // TODO: Connect floors with ladders
        blocks.setBlock(blockPos, context.getBlock("oak_stairs"));
    } else if (objectId === 8) {
        // Chair
        // TODO: Use stairs with the appropriate orientation
        blocks.setBlock(blockPos, context.getBlock("oak_slab"));
    } else if (objectId === 10) {
        // Long table
        blocks.setBlock(blockPos, context.getBlock("oak_planks"));
    } else if (objectId === 11) {
        // Ornate chair
        // TODO: Use stairs with the appropriate orientation
        blocks.setBlock(blockPos, context.getBlock("oak_slab"));
    } else if (objectId === 13) {
        // Gravestone 1 (?)
        blocks.setBlock(blockPos, context.getBlock("cobblestone"));
    } else if (objectId === 14) {
        // Gravestone 2 (?)
        blocks.setBlock(blockPos, context.getBlock("cobblestone"));
    } else if (objectId === 16) {
        // Table (with white tablecloth)
        blocks.setBlock(blockPos, context.getBlock("white_wool"));
    } else if (objectId === 20) {
        // Church altar (with white tablecloth)
        // TODO: Put candles on top
        blocks.setBlock(blockPos, context.getBlock("white_wool"));
    } else if (objectId === 21) {
        // Fencepost
        blocks.setBlock(blockPos, context.getBlock("smooth_stone"));
    } else if (objectId === 24) {
        // Church pew
        // TODO: Use stairs with the appropriate orientation
        blocks.setBlock(blockPos, context.getBlock("oak_slab"));
    } else if (objectId === 26) {
        // Lampstand
        blocks.setBlock(blockPos, context.getBlock("end_rod[facing=down]"));
        blocks.setBlock(blockPos.add(0, 1, 0), context.getBlock("white_candle[lit=true]"));
    } else if (objectId === 27) {
        // Fountain
        blocks.setBlock(blockPos, context.getBlock("water_cauldron[level=3]"));
    } else if (objectId === 30) {
        // Counter
        blocks.setBlock(blockPos, context.getBlock("oak_planks"));
    } else if (objectId === 35) {
        // Fern
        blocks.setBlock(blockPos, context.getBlock("fern"));
    } else if (objectId === 38) {
        // Flower
        blocks.setBlock(blockPos, context.getBlock("poppy"));
    } else if (objectId === 39) {
        // Mushroom
        blocks.setBlock(blockPos, context.getBlock("brown_mushroom"));
    } else if (objectId === 46) {
        // Railing
        blocks.setBlock(blockPos, context.getBlock("jungle_fence"));
    } else if (objectId === 55) {
        // Lumbridge cow field (feeding trough?)
        blocks.setBlock(blockPos, context.getBlock("composter"));
    } else if (objectId === 61) {
        // Wooden fence gate
        // TODO: This is not positioned correctly
        blocks.setBlock(blockPos, context.getBlock("oak_fence_gate"));
    } else if (objectId === 62) {
        // Signpost
        blocks.setBlock(blockPos, context.getBlock("oak_sign"));
    } else if (objectId === 65) {
        // Open double doors (Lumbridge castle)
        // TODO: Need to know the wall position to set the orientation
        blocks.setBlock(blockPos, context.getBlock("air"));
    } else if (objectId === 90) {
        // Hanging sign
        blocks.setBlock(blockPos, context.getBlock("oak_sign"));
    } else if (objectId === 119) {
        // Furnace
        blocks.setBlock(blockPos, context.getBlock("furnace"));
    } else {
        player.print("Unknown object type: " + objectId);
        blocks.setBlock(blockPos, context.getBlock("lime_wool"));
    }
}

function placeTree(blockPos) {
    // Based on: https://github.com/EngineHub/WorldEdit/blob/master/worldedit-core/src/main/java/com/sk89q/worldedit/command/tool/TreePlanter.java

    // First try an Oak tree
    var treeTypeEnum = TreeGenerator.TreeType.lookup("oak");
    for (var attempt = 0; attempt < 10; attempt++) {
        if (treeTypeEnum.generate(blocks, blockPos)) {
            // Success
            return;
        }
    }

    // If that fails, try Spruce
    // (Oak tends to fail near fences due to its short trunk)
    treeTypeEnum = TreeGenerator.TreeType.lookup("spruce");
    for (var attempt = 0; attempt < 10; attempt++) {
        if (treeTypeEnum.generate(blocks, blockPos)) {
            // Success
            return;
        }
    }

    // Fallback
    blocks.setBlock(blockPos, context.getBlock("dead_bush"));
}

function placeRoof(roofTexture, blockPos, facing) {
    if (roofTexture === 1) {
        // Normal tile roof
        if (facing) {
            blocks.setBlock(blockPos, context.getBlock("polished_granite_stairs[facing=" + facing + "]"));
        } else {
            blocks.setBlock(blockPos, context.getBlock("polished_granite"));
        }
    } else if (roofTexture === 2) {
        // Wooden roof
        if (facing) {
            blocks.setBlock(blockPos, context.getBlock("spruce_stairs[facing=" + facing + "]"));
        } else {
            blocks.setBlock(blockPos, context.getBlock("spruce_planks"));
        }
    } else if (roofTexture === 3) {
        // Gray slate (exam centre)
        if (facing) {
            blocks.setBlock(blockPos, context.getBlock("cobbled_deepslate_stairs[facing=" + facing + "]"));
        } else {
            blocks.setBlock(blockPos, context.getBlock("cobbled_deepslate"));
        }
    } else if (roofTexture === 6) {
        // Straw roof (Shantay Pass)
        if (facing) {
            blocks.setBlock(blockPos, context.getBlock("smooth_sandstone_stairs[facing=" + facing + "]"));
        } else {
            blocks.setBlock(blockPos, context.getBlock("smooth_sandstone"));
        }
    } else {
        player.print("Unknown roof texture: " + roofTexture);
        blocks.setBlock(blockPos, context.getBlock("pink_wool"));
    }
}

////////////////////////////////////////////////////////////////////////////////
// Utilities
////////////////////////////////////////////////////////////////////////////////

function getContainingSectorCoords(blockPos) {
    // See: https://github.com/2003scape/rsc-landscape/blob/master/src/landscape.js#L173
    var sectorX = Math.floor(blockPos.getX() / SECTOR_SIZE);
    var sectorY = Math.floor(blockPos.getZ() / SECTOR_SIZE);

    // RuneScape and Minecraft use different co-ordinate systems so we have to
    // flip our x co-ordinates to prevent the world becoming mirrored.
    sectorX = NUM_SECTORS_X - sectorX;

    // In effect, adding MIN_SECTOR_X/Y offsets the entire RuneScape world
    // relative to the Minecraft world, so that we can start generating from
    // (0, 0). As far as I can tell it's a convenience, not a necessity.
    sectorX += MIN_SECTOR_X;
    sectorY += MIN_SECTOR_Y;

    return BlockVector3.at(sectorX, 0, sectorY);
}

function getSectorId(layer, sectorX, sectorY) {
    return "h" + layer + "x" + sectorX + "y" + sectorY;
}

function getMinBlockPosForSector(sectorX, sectorY) {
    // Convert from RuneScape -> Minecraft co-ordinates.
    // This is basically the opposite of `getContainingSectorCoords`.
    var mcSectorX = (sectorX - MIN_SECTOR_X);
    var mcSectorZ = (sectorY - MIN_SECTOR_Y);

    mcSectorX = -(mcSectorX - NUM_SECTORS_X);

    var blockX = mcSectorX * SECTOR_SIZE;
    var blockZ = mcSectorZ * SECTOR_SIZE;

    return BlockVector3.at(blockX, BEDROCK_LEVEL, blockZ);
}

function getBlockPosForTile(sectorMinBlockPos, tileX, tileY) {
    // Convert from RuneScape -> Minecraft co-ordinates (inverted x-axis)
    var blockX = sectorMinBlockPos.getX() + (SECTOR_SIZE - tileX - 1);
    var blockY = sectorMinBlockPos.getY();
    var blockZ = sectorMinBlockPos.getZ() + tileY;
    return BlockVector3.at(blockX, blockY, blockZ);
}

////////////////////////////////////////////////////////////////////////////////
// Data loading
////////////////////////////////////////////////////////////////////////////////

function loadLandscapeData(filename) {
    // Load ZIP file
    var file = new File(filename);
    if (!file.exists()) {
        player.printError("Specified landscape file does not exist");
    }
    return new ZipFile(file);
}

function loadSector(archive, sectorEntry) {
    buffer = streamToBuffer(new BufferedInputStream(archive.getInputStream(sectorEntry)));
    sector = new Array(SECTOR_SIZE);
    for (var x = 0; x < SECTOR_SIZE; x++) {
        sector[x] = new Array(SECTOR_SIZE);
        for (var y = 0; y < SECTOR_SIZE; y++) {
            // See: https://github.com/Open-RSC/2D-Landscape-Editor/blob/main/src/main/java/org/openrsc/editor/model/Tile.java#L206
            var tile = {}
            tile.groundElevation = toUnsigned(buffer.get());
            tile.groundTexture = toUnsigned(buffer.get());
            tile.groundOverlay = toUnsigned(buffer.get());
            tile.roofTexture = toUnsigned(buffer.get());
            tile.rightBorderWall = toUnsigned(buffer.get());
            tile.topBorderWall = toUnsigned(buffer.get());
            // 0-12000 is /, 12000-48000 is \, 48000+ is an object ID
            tile.diagonalWalls = buffer.getInt();
            sector[x][y] = tile;
        }
    }
    return sector;
}

function streamToBuffer(inputStream) {
    var size = inputStream.available();
    var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, size);
    for (var i = 0; i < size; i++) {
        buffer[i] = toSigned(inputStream.read());
    }

    // TODO: This would be more efficient but doesn't seem to work!
    //inputStream.read(buffer, 0, size);

    return ByteBuffer.wrap(buffer);
}

function toSigned(val) {
    if (val > 127) {
        val -= 256;
    }
    return val;
}

function toUnsigned(val) {
    if (val < 0) {
        val += 256;
    }
    return val;
}

////////////////////////////////////////////////////////////////////////////////
// Entry point
////////////////////////////////////////////////////////////////////////////////

function main() {
    context.checkArgs(2, 3, "<filename> <region|full|chunk> [--clean]");

    // Find relevant sectors
    var minSectorCoords;
    var maxSectorCoords;
    if (argv.length > 2) {
        if (argv[2].equals("full")) {
            player.print("Attempting full map generation...");
            minSectorCoords = BlockVector3.at(MIN_SECTOR_X, 0, MIN_SECTOR_Y);
            maxSectorCoords = BlockVector3.at(MAX_SECTOR_X, 0, MAX_SECTOR_Y);
        } else if (argv[2].equals("chunk")) {
            player.print("Attempting single chunk generation...");
            minSectorCoords = getContainingSectorCoords(player.getBlockLocation());
            maxSectorCoords = minSectorCoords;
        } else if (argv[2].equals("region")) {
            // Use selection
            player.print("Attempting generation from selection...");
            region = session.getRegionSelector(player.getWorld()).getRegion();
            var minRegionPos = region.getMinimumPoint();
            var maxRegionPos = region.getMaximumPoint();
            minSectorCoords = getContainingSectorCoords(minRegionPos);
            maxSectorCoords = getContainingSectorCoords(maxRegionPos);
        } else {
            player.printError("Unknown parameter: " + argv[2]);
            return;
        }
    }

    // Parse clean flag
    var clean = false;
    if (argv.length > 3) {
        if (argv[3].equals("--clean")) {
            player.print("Clean enabled");
            clean = true;
        } else {
            player.printError("Unknown parameter: " + argv[3]);
        }
    }

    // Load landscape data
    // TODO: We are currently loading a "Landscape.data" file but this is not the
    // original map format. We should be loading .jag and .mem files as seen here:
    // https://github.com/2003scape/rsc-landscape#example
    var landscapeArchive;
    try {
        landscapeArchive = loadLandscapeData(argv[1]);
    } catch (err) {
        player.printError("Error reading landscape data");
        player.printError(err);
        return;
    }

    // Load / process requested sectors
    for (var sectorX = minSectorCoords.getX(); sectorX <= maxSectorCoords.getX(); sectorX++) {
        for (var sectorY = minSectorCoords.getZ(); sectorY <= maxSectorCoords.getZ(); sectorY++) {
            var sector = new Array(NUM_LAYERS);

            // Load all layers
            for (var layer = 0; layer < NUM_LAYERS; layer++) {
                var sectorId = getSectorId(layer, sectorX, sectorY);
                var sectorEntry = landscapeArchive.getEntry(sectorId);
                if (sectorEntry) {
                    player.print("Loading sector: " + sectorId);
                    sector[layer] = loadSector(landscapeArchive, sectorEntry);
                } else {
                    player.printError("Invalid sector: " + sectorId);
                }
            }

            player.print("Processing sector");
            processSector(sector, sectorX, sectorY, clean);
        }
    }
}

var blocks = context.remember();
var session = context.getSession();
var player = context.getPlayer();
var region;

main();
