import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CustomizationOptionResponseDto } from './customization-option-response.dto';

export class CustomizationGroupResponseDto {
  @ApiProperty({ example: 219 })
  id: number;
  @ApiProperty({ example: 'Size' })
  name: string;
  @ApiProperty({ example: false })
  required: boolean;
  @ApiProperty({ example: 0 })
  minSelectable: number;
  @ApiProperty({ example: 1 })
  maxSelectable: number;
  @ApiProperty({ example: 147 })
  menuItemId: number;
  @ApiProperty({ type: () => [CustomizationOptionResponseDto] })
  @Type(() => CustomizationOptionResponseDto)
  customizationOptions: CustomizationOptionResponseDto[];
}
