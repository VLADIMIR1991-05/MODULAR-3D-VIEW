require 'sketchup.rb'
require 'extensions.rb'

module Modular3D
  module View
    EXTENSION = SketchupExtension.new(
      'MODULAR-3D VIEW',
      File.join('modular_3d_view', 'main')
    )
    EXTENSION.description = 'Prepara modelos SketchUp para MODULAR-3D VIEW sin modificar el archivo SKP original.'
    EXTENSION.version = '0.1.1'
    EXTENSION.creator = 'MODULAR-3D'
    Sketchup.register_extension(EXTENSION, true)
  end
end
