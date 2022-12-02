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

// Roof replaces the top block of the wall (if present)
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

    // For each tile in the sector...
    for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
        for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
            processTile(sectorMinBlockPos, sector, tileX, tileY);
        }
    }
}

function processTile(sectorMinBlockPos, sector, tileX, tileY) {
    // We need to store ground tile settings as they can affect all layers
    var groundElevation = 0;
    var groundOverlaySettings = null;

    // Build each layer in turn
    for (var layer = 0; layer < NUM_LAYERS; layer++) {
        var tile = sector[layer][tileX][tileY];

        // Find block position corresponding to tile (at lowest possible point)
        var blockPos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);

        ////////////////////////////////////////////////////////////////////////
        // Ground
        ////////////////////////////////////////////////////////////////////////

        // Get tile overlay settings
        var overlaySettings = null;
        if (tile.groundOverlay) {
            overlaySettings = getOverlaySettings(tile.groundOverlay);
        }

        // Pick the block type based on the tile color
        var blockType = getBlockTypeFromPalette(tile.groundTexture);

        var elevation = 0;

        // Determine desired elevation and place supporting blocks
        if (layer === 0) {
            groundOverlaySettings = overlaySettings;

            // Place bedrock as a base
            var bedrock = context.getBlock("bedrock");
            blocks.setBlock(blockPos, bedrock);

            // Pick the block type to be used by any supporting blocks
            var supportType = blockType == context.getBlock("dirt_path")
                ? context.getBlock("dirt")
                : blockType;

            // RSC elevation seems to range from: 0 (highest point) to 256 (lowest point),
            // which we map to the range: 9 (highest point) to 1 (lowest point).
            elevation = 5 + ((tile.groundElevation) / 32);
            if (overlaySettings && overlaySettings.overrideElevation) {
                elevation = overlaySettings.overrideElevation;
            }

            // This is needed by subsequent layers
            groundElevation = elevation;

            // Place supporting blocks up to the desired elevation
            for (var i = 1; i < elevation; i++) {
                blockPos = blockPos.withY(BEDROCK_LEVEL + i);
                if (i < elevation) {
                    blocks.setBlock(blockPos, supportType);
                }
            }
        } else {
            elevation = groundElevation + layer * WALL_HEIGHT;
        }

        // Place ground
        if (layer === 0) {
            blockPos = blockPos.withY(BEDROCK_LEVEL + elevation);
            blocks.setBlock(blockPos, blockType);
        }

        // Place overlay block
        if (isOverlayPermitted(layer, overlaySettings)) {
            if (!overlaySettings.replaceGround) {
                elevation += 1;
            }
            blockPos = blockPos.withY(BEDROCK_LEVEL + elevation);
            blocks.setBlock(blockPos, overlaySettings.block);
        }

        ////////////////////////////////////////////////////////////////////////
        // Walls
        ////////////////////////////////////////////////////////////////////////

        var indoors = isTileIndoors(overlaySettings, groundOverlaySettings);
        var wallType = tile.topBorderWall || tile.rightBorderWall || tile.diagonalWalls;
        var hasWall = wallType > 0 && wallType < 48000;
        var roofHeight = ROOF_HEIGHT;
        if (hasWall) {
            // Normalize wall type
            if (wallType >= 48000) {
                wallType -= 48000;
            } else if (wallType >= 12000) {
                wallType -= 12000;
            }

            // Determine the wall's facing
            var facing;
            if (indoors) {
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
            var wallSettings = getWallSettings(tile, wallType, indoors, facing);
            roofHeight = wallSettings.height;

            // Place walls at the appropriate locations.
            // This is essentially unsolveable since walls in RS are 2D, but we
            // take the approach of placing walls for "indoor" tiles on the
            // neighbouring tile, and placing walls for "outdoor" tiles on the
            // current tile. This ensures that buildings stay approximately the
            // correct size.
            // TODO: This causes problems at sector boundaries
            if (indoors) {
                if (tile.rightBorderWall && tile.topBorderWall) {
                    // Inside corner: we need to place THREE neighbouring blocks
                    // (the 2 shifted edges, plus a corner block)
                    var wallPos = blockPos.add(1, 0, 0);
                    buildWall(layer, wallPos, elevation, wallSettings);
                    wallPos = blockPos.add(0, 0, -1);
                    buildWall(layer, wallPos, elevation, wallSettings);
                    wallPos = blockPos.add(1, 0, -1);
                    buildWall(layer, wallPos, elevation, wallSettings);
                } else if (tile.rightBorderWall) {
                    // Inside edge: shift the wall outwards
                    var wallPos = blockPos.add(1, 0, 0);
                    buildWall(layer, wallPos, elevation, wallSettings);
                } else if (tile.topBorderWall) {
                    // Inside edge: shift the wall outwards
                    var wallPos = blockPos.add(0, 0, -1);
                    buildWall(layer, wallPos, elevation, wallSettings);
                } else {
                    // Diagonal wall: just place a wall at the current tile
                    buildWall(layer, blockPos, elevation, wallSettings);
                }
            } else {
                // Just place a wall at the current tile
                buildWall(layer, blockPos, elevation, wallSettings);
            }
        }

        ////////////////////////////////////////////////////////////////////////
        // Objects
        ////////////////////////////////////////////////////////////////////////

        if (wallType >= 48000) {
            var objectId = wallType - 48000;
            placeObject(objectId, blockPos.withY(BEDROCK_LEVEL + elevation));
        }

        ////////////////////////////////////////////////////////////////////////
        // Roof
        ////////////////////////////////////////////////////////////////////////

        if (tile.roofTexture) {
            blockPos = blockPos.withY(BEDROCK_LEVEL + elevation + roofHeight);
            // TODO: Not all roofs use the same texture
            blocks.setBlock(blockPos, context.getBlock("polished_granite"));
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
        // Cliffs
        overlaySettings.block = context.getBlock("andesite");
    } else if (groundOverlay === 11) {
        // Lava
        overlaySettings.block = context.getBlock("lava");
    } else if (groundOverlay === 15) {
        // Purple carpet
        overlaySettings.block = context.getBlock("purple_wool");
        overlaySettings.indoors = true;
    } else if (groundOverlay === 20) {
        // Agility training area - log?
        overlaySettings.block = context.getBlock("oak_log");
    } else if (groundOverlay === 23) {
        // Digsite
        overlaySettings.block = context.getBlock("brown_wool");
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

function getWallSettings(tile, wallType, indoors, facing) {
    var wallSettings = {
        block: context.getBlock("red_wool"),
        height: WALL_HEIGHT,
        doorBlock: null,
        windowBlock: null
    };

    if (wallType === 1) {
        // Stone wall
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 2) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 3) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 4) {
        // Stone wall window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else if (facing === "east") {
            wallSettings.windowBlock = context.getBlock("glass_pane[north=true,south=true]");
        } else {
            wallSettings.windowBlock = context.getBlock("glass_pane[east=true,west=true]");
        }
    } else if (wallType === 5) {
        // Wooden fence
        wallSettings.block = context.getBlock("jungle_fence");
        wallSettings.height = 2;
    } else if (wallType === 6) {
        // Metal fence
        wallSettings.block = context.getBlock("iron_bars");
        wallSettings.height = 2;
    } else if (wallType === 7) {
        // Stained glass window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else if (facing === "east") {
            wallSettings.windowBlock = context.getBlock("blue_stained_glass_pane[north=true,south=true]");
        } else {
            wallSettings.windowBlock = context.getBlock("blue_stained_glass_pane[east=true,west=true]");
        }
    } else if (wallType === 8) {
        // Stone wall (extra tall?)
        wallSettings.block = context.getBlock("stone_bricks");
    } else if (wallType === 9) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 14) {
        // Stone wall window
        wallSettings.block = context.getBlock("stone_bricks");
        if (tile.diagonalWalls) {
            wallSettings.windowBlock = context.getBlock("glass");
        } else if (facing === "east") {
            wallSettings.windowBlock = context.getBlock("glass_pane[north=true,south=true]");
        } else {
            wallSettings.windowBlock = context.getBlock("glass_pane[east=true,west=true]");
        }
    } else if (wallType === 15) {
        // Plaster / panelled wall
        wallSettings.block = getBlockForPanelledWall(tile);
    } else if (wallType === 16) {
        // Panelled window
        wallSettings.block = getBlockForPanelledWall(tile);
        wallSettings.windowBlock = context.getBlock("jungle_trapdoor[open=true,facing=" + facing + "]");
    } else if (wallType === 17) {
        // Opening (with overhang above)
        wallSettings.block = context.getBlock("air");
    } else if (wallType === 19) {
        // Slimy wall
        wallSettings.block = context.getBlock("mossy_stone_bricks");
    } else if (wallType === 24) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 44) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 63) {
        // Stone fence
        wallSettings.block = context.getBlock("stone_brick_wall");
        wallSettings.height = 2;
    } else if (wallType === 95) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 110) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 121) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 123) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 124) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 128) {
        // Wooden fence (extra short)
        wallSettings.block = context.getBlock("jungle_fence");
        wallSettings.height = 1;
    } else if (wallType === 139) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else if (wallType === 153) {
        // Doorway
        wallSettings.block = getDoorwayWallBlock(facing);
        wallSettings.doorBlock = "oak_door[facing=" + facing + "]";
    } else {
        player.print("Unknown wall type: " + wallType);
    }

    return wallSettings;
}

function getBlockForPanelledWall(tile) {
    // To give some extra texture, we use wood for the corners.
    // TODO: This only works for some corners. At other corners it is
    // the tile on the *outside* of the building that is responsible
    // for generating the wall.
    if (tile.rightBorderWall && tile.topBorderWall) {
        return context.getBlock("stripped_jungle_log");
    } else {
        return context.getBlock("mushroom_stem");
    }
}

// The goal here is to return something inoffensive since we don't know what
// blocks it needs to blend with
function getDoorwayWallBlock(facing) {
    //var axis = getAxisFromFacing(facing);
    //return context.getBlock("stripped_oak_log[axis=" + axis + "]");
    return context.getBlock("glass");
}

function getAxisFromFacing(facing) {
    return (facing === "east" || facing === "west") ? "x" : "z";
}

function buildWall(layer, wallPos, elevation, wallSettings) {
    var startY = -1;

    if (wallSettings.doorBlock) {
        startY = 1;
    } else if (layer === 0) {
        // Start underground in case the wall is on a steep slope
        startY = -5;
    }

    for (var i = startY; i <= wallSettings.height; i++) {
        wallPos = wallPos.withY(BEDROCK_LEVEL + elevation + i);
        if (wallSettings.doorBlock && i == 1) {
            // Door (lower)
            // TODO: Place an air block in front of the door in case it
            // is embedded in the ground.
            var doorBlock = wallSettings.doorBlock.replace("]", ",half=lower]");
            blocks.setBlock(wallPos, context.getBlock(doorBlock));
        } else if (wallSettings.doorBlock && i == 2) {
            // Door (upper)
            var doorBlock = wallSettings.doorBlock.replace("]", ",half=upper]");
            blocks.setBlock(wallPos, context.getBlock(doorBlock));
        } else if (wallSettings.windowBlock && i > 1 && i < wallSettings.height - 1) {
            // Window
            blocks.setBlock(wallPos, wallSettings.windowBlock);
        } else {
            blocks.setBlock(wallPos, wallSettings.block);
        }
    }
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
        // Tree
        // TODO: Make a real tree
        blocks.setBlock(blockPos, context.getBlock("dead_bush"));
    } else if (objectId === 38) {
        // Flower
        blocks.setBlock(blockPos, context.getBlock("poppy"));
    } else if (objectId === 39) {
        // Mushroom
        blocks.setBlock(blockPos, context.getBlock("brown_mushroom"));
    } else if (objectId === 46) {
        // Railing
        blocks.setBlock(blockPos, context.getBlock("jungle_fence"));
    } else if (objectId === 61) {
        // Fence gate
        // TODO: This is not positioned in the fence!
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
        player.print("Found object: " + objectId);
        blocks.setBlock(blockPos, context.getBlock("lime_wool"));
    }
}

function placeTree(blockPos) {
    // Based on: https://github.com/EngineHub/WorldEdit/blob/master/worldedit-core/src/main/java/com/sk89q/worldedit/command/tool/TreePlanter.java
    var treeTypeEnum = TreeGenerator.TreeType.lookup("oak");
    for (var attempt = 0; attempt < 10; attempt++) {
        if (treeTypeEnum.generate(blocks, blockPos)) {
            // Success
            return;
        }
    }

    // Fallback
    blocks.setBlock(blockPos, context.getBlock("dead_bush"));
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
