// src/order/order.controller.ts
import {
  Controller,
  Post,
  Patch,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { OrderService } from './order.service';
import { CreateOrderChunkDto } from './dto/create-order-chunk.dto';
import { UpdateChunkStatusDto } from './dto/update-chunk-status.dto';
import { StandardApiResponse } from 'src/common/dto/standard-api-response.dto'; // Import base response
import { Order, OrderChunk } from '@prisma/client'; // Import Prisma types for responses

@ApiTags('Orders')
@Controller('orders')
export class OrderController {
  constructor(private orderService: OrderService) {}

  @Post('session/:sessionId/chunk') // Changed route slightly for clarity
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a new order chunk with items to an open order for a session',
    description:
      'Finds or creates an OPEN order for the given session ID, then adds a new chunk with items and selected customizations.',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'The numeric ID of the TableSession',
    type: Number,
  })
  @ApiResponse({
    status: 201, // Correct status code for creation
    description: 'New order chunk created successfully',
    type: StandardApiResponse<OrderChunk>, // Use generic type with OrderChunk
    // The schema example below needs manual update if exact structure is needed in Swagger UI
  })
  /* Example of how to manually define the response schema for Swagger if needed
    @ApiResponse({
    status: 201,
    description: 'New order chunk created successfully',
     schema: {
       allOf: [
         { $ref: getSchemaPath(StandardApiResponse) },
         {
           properties: {
             data: {
               // Define OrderChunk structure here based on Prisma model + includes
               // Example:
               type: 'object',
               properties: {
                  id: { type: 'number', example: 12 },
                  orderId: { type: 'number', example: 5 },
                  status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED'], example: 'PENDING' },
                  createdAt: { type: 'string', format: 'date-time' },
                  updatedAt: { type: 'string', format: 'date-time' },
                  chunkItems: {
                    type: 'array',
                    items: {
                       type: 'object',
                       properties: {
                         id: { type: 'number', example: 101 },
                         menuItemId: { type: 'number', example: 7 },
                         price: { type: 'number', format: 'double', example: 8.50 },
                         quantity: { type: 'number', example: 2 },
                         finalPrice: { type: 'number', format: 'double', example: 19.00 },
                         notes: { type: 'string', example: 'Extra spicy', nullable: true },
                         customizations: {
                           type: 'array',
                           items: {
                             type: 'object',
                             properties: {
                               id: { type: 'number', example: 301 },
                               customizationOptionId: { type: 'number', example: 101 },
                               quantity: { type: 'number', example: 1},
                               finalPrice: { type: 'number', format: 'double', example: 2.00 },
                               // Include customizationOption details if needed
                             }
                           }
                         }
                       } // end chunkItem properties
                    } // end items object
                  } // end chunkItems array
               } // end data properties
             } // end data object
           } // end properties
         } // end second part of allOf
       ] // end allOf
     } // end schema
   }) */
  @ApiResponse({
    status: 400,
    description: 'Invalid input data (e.g., empty items, invalid IDs)',
  })
  @ApiResponse({ status: 403, description: 'Session is closed' })
  @ApiResponse({ status: 404, description: 'Session or MenuItem not found' })
  async addChunk(
    @Param('sessionId', ParseIntPipe) sessionId: number, // Ensure ID is parsed as integer
    @Body() createOrderChunkDto: CreateOrderChunkDto,
  ): Promise<StandardApiResponse<OrderChunk>> {
    // Use correct return type
    const chunk = await this.orderService.addChunk(
      sessionId,
      createOrderChunkDto,
    );
    // Use the StandardApiResponse static helper for success
    return StandardApiResponse.success(chunk, 'New order chunk created');
  }

  @Patch('chunk/:chunkId/status')
  @ApiOperation({
    summary:
      'Update the status of an order chunk (e.g., for Kitchen Display System)',
  })
  @ApiParam({
    name: 'chunkId',
    description: 'The numeric ID of the OrderChunk',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Order chunk status updated successfully',
    type: StandardApiResponse<OrderChunk>, // Use generic type
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid status value or illegal transition',
  })
  @ApiResponse({ status: 404, description: 'Order Chunk not found' })
  async updateChunkStatus(
    @Param('chunkId', ParseIntPipe) chunkId: number, // Parse ID
    @Body() updateChunkStatusDto: UpdateChunkStatusDto,
  ): Promise<StandardApiResponse<OrderChunk>> {
    // Use correct return type
    const updatedChunk = await this.orderService.updateChunkStatus(
      chunkId,
      updateChunkStatusDto.status,
    );
    return StandardApiResponse.success(updatedChunk, 'Chunk status updated');
  }

  @Post('session/:sessionId/pay')
  @ApiOperation({
    summary:
      'Mark the open order for the session as PAID and close the session',
    description:
      'Finds the OPEN order for the session, marks it as PAID, and sets the TableSession status to CLOSED.',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'The numeric ID of the TableSession',
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Order paid and session closed successfully',
    type: StandardApiResponse<Order>, // Use generic type with Order
  })
  @ApiResponse({
    status: 403,
    description: 'Session or Order already closed/paid',
  })
  @ApiResponse({
    status: 404,
    description: 'No open order found for the session',
  })
  async payOrder(
    @Param('sessionId', ParseIntPipe) sessionId: number, // Parse ID
  ): Promise<StandardApiResponse<Order>> {
    // Use correct return type
    const paidOrder = await this.orderService.payOrder(sessionId);
    return StandardApiResponse.success(paidOrder, 'Order paid, session closed');
  }
}
